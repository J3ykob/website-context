import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";

// One Durable Object (and at most one sandbox) per project. A run:
//   1. masks personal data in the prompt and files (PiiMasker), keeps the mapping in this object's
//      storage - never in the sandbox;
//   2. starts the sandbox (Internet off; only the model API is reachable, its key added outside),
//      writes the masked files, AGENTS.md and opencode.json, starts opencode in the background;
//   3. a 30 s alarm keeps the sandbox awake, enforces the cost cap, and finishes the run when the agent
//      exits: changed and new files are read, unmasked, stored as the result; the mapping is deleted
//      and the sandbox destroyed.
// The Render server polls the result and owns everything after that (repository, verification).

const PROJECT_DIR = "/workspace/project";
const TASK_DIR = "/workspace/task";
const EVENTS_PATH = `${TASK_DIR}/events.jsonl`;
const STDERR_PATH = `${TASK_DIR}/stderr.log`;
const EXIT_CODE_PATH = `${TASK_DIR}/exit-code`;
const PID_PATH = `${TASK_DIR}/pid`;
const BEFORE_PATH = `${TASK_DIR}/before.txt`;
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;
const CHECK_INTERVAL_MS = 30 * 1_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_FILES = 60;
const MAX_OUTPUT_BYTES = 6 * 1024 * 1024;
const CHUNK = 1_000_000;
// Files the runner itself writes; never part of the result.
const RUNNER_FILES = new Set(["AGENTS.md", "opencode.json"]);

// exec() does not inherit start() env; every command that makes HTTPS requests needs the CA.
const TRUST_ENV = { NODE_EXTRA_CA_CERTS: CA_PATH, CURL_CA_BUNDLE: CA_PATH, SSL_CERT_FILE: CA_PATH };
const OPENCODE_ENV = {
  // The outbound handler replaces this placeholder with the real key.
  OPENROUTER_API_KEY: "provided-by-worker",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_SHARE: "1",
  HOME: "/workspace/task/home",
};
// Output goes to files so the agent keeps running after the request that started it ends.
const TASK_SCRIPT = `"$@" >${EVENTS_PATH} 2>${STDERR_PATH}
printf '%s\\n' "$?" >${EXIT_CODE_PATH}.tmp && mv ${EXIT_CODE_PATH}.tmp ${EXIT_CODE_PATH}`;

// Personal-data rules for AGENTS.md, naming only the placeholders this project has (an example list
// invites the model to use placeholders that do not exist, e.g. to sign a message).
function piiRules(placeholders: string[]): string {
  if (!placeholders.length) return "";
  return `
## Dane osobowe (obowiązkowe)
Dane osobowe klienta są w plikach zastąpione znacznikami: ${placeholders.join(", ")}.
Kod podmieni je na prawdziwe dane po zakończeniu pracy.
- Używaj tylko tych znaczników. Przepisuj je dokładnie (z nawiasami i numerem), bez odmiany i bez dzielenia.
- Nie twórz innych znaczników w nawiasach kwadratowych i nie zgaduj, co oznaczają.
- Nie zwracaj się do osoby po imieniu (bez wołacza): powitanie bez imienia, np. "Dzień dobry,".
- Nie podpisuj wiadomości nazwą firmy ani osoby, chyba że zadanie podaje podpis.
`;
}

export interface ModelSpec {
  id: string; // OpenRouter id, e.g. deepseek/deepseek-v4.1-flash
  name?: string;
  context?: number;
  output?: number;
  // USD per million tokens
  cost: { input: number; output: number; cache_read?: number };
}

export interface RunRequest {
  projectId: string;
  prompt: string;
  rules: string; // AGENTS.md (the project's rules), personal-data rules are appended here
  files: Record<string, string>; // relative path -> text; may hold customer data: masked
  // The businesses' own published data (price lists, offer indexes): written as is. Masking it would
  // hide item ids and prices the model mistakes for secrets or account numbers.
  publicFiles?: Record<string, string>;
  model: ModelSpec;
  maxSteps?: number;
  timeoutSec?: number;
  maxCostUsd?: number;
  allow?: string[]; // the business's own public data: never masked
  catalog?: string[]; // words from the business's offer (brands, product names): never masked as companies
  keepMasked?: string[]; // outputs returned with placeholders (e.g. requests to other businesses: no customer data leaves)
}

export interface RunUsage { steps: number; costUsd: number; tokensIn: number; tokensOut: number; tokensCached: number; toolCalls: number; toolErrors: number }
export interface OutputFile { path: string; encoding: "utf-8" | "base64"; content: string; size: number }
export interface RunResult {
  runId: string;
  state: "succeeded" | "failed" | "lost";
  stopReason: "done" | "error" | "timeout" | "cost_cap" | "step_cap" | "lost" | "cancelled";
  error?: string;
  finalText: string;
  files: OutputFile[];
  skippedFiles: string[];
  unknownPlaceholders: string[];
  alteredPlaceholders: string[];
  piiMasked: number;
  usage: RunUsage;
  model: string;
  startedAt: string;
  finishedAt: string;
  timing?: Record<string, number>;
}
export type RunStatus =
  | { state: "none" }
  | { state: "running"; runId: string; startedAt: string; elapsedMs: number; usage: RunUsage }
  | { state: "done"; result: RunResult };

interface Meta { runId: string; projectId: string; model: string; startedAt: string; maxCostUsd: number; maxSteps: number; piiMasked: number; keepMasked?: string[]; stopReason?: RunResult["stopReason"] }

interface AgentState extends DurableObjectState {
  readonly exports: { readonly Outbound: (opts: object) => Fetcher } & Record<string, unknown>;
}

export class ProjectAgent extends DurableObject<Env> {
  readonly #container: Container;
  readonly #files: Files;
  readonly #outbound: Fetcher;

  constructor(ctx: AgentState, env: Env) {
    super(ctx, env);
    const c = ctx.container;
    if (c === undefined) throw new Error("Container attachment is unavailable");
    this.#container = c;
    this.#files = new Files(c);
    this.#outbound = ctx.exports.Outbound({});
    // Each instance sets its own timeout (not inherited). Not under blockConcurrencyWhile: a stuck call
    // there resets the object.
    if (c.running) c.setInactivityTimeout(INACTIVITY_TIMEOUT_MS).catch(() => {});
  }

  // In-memory guards instead of blockConcurrencyWhile (capped at 30 s; a cold start of the masker and the
  // sandbox can take longer). A Durable Object runs one instance, so these see every request.
  #starting = false;
  #finishing: Promise<void> | null = null;

  async start(name: string, req: RunRequest): Promise<{ state: "started"; runId: string; timing: Record<string, number> } | { state: "busy" }> {
    if (this.#starting || this.#finishing) return { state: "busy" };
    this.#starting = true;
    const timing: Record<string, number> = {};
    let t = Date.now();
    const lap = (k: string) => { const n = Date.now(); timing[k] = n - t; t = n; };
    try {
      const meta = this.#meta();
      if (meta && !this.#hasResult() && this.#container.running && (await this.#exitCode()) === undefined) return { state: "busy" };
      this.#clear();

      // 1. Mask. Fails closed: no masker, no run.
      const texts: Record<string, string> = { "\u0000prompt": req.prompt };
      for (const [p, t] of Object.entries(req.files)) texts[`f:${safePath(p)}`] = t;
      // The sandbox starts while the masker works (it gets files only after masking).
      const sandbox = this.#ensureContainer(name).then(() => { timing.containerReadyMs = Date.now() - t; });
      const masked = await this.env.MASKER.getByName("pii").mask({ texts, allow: req.allow ?? [], catalog: req.catalog ?? [] });
      lap("maskMs");
      const runId = crypto.randomUUID();
      const m: Meta = {
        runId, projectId: req.projectId, model: req.model.id, startedAt: new Date().toISOString(),
        maxCostUsd: req.maxCostUsd ?? 0.5, maxSteps: req.maxSteps ?? 60, piiMasked: masked.found, keepMasked: (req.keepMasked ?? []).slice(0, 20),
      };
      this.ctx.storage.kv.put("vault", JSON.stringify(masked.state));
      this.ctx.storage.kv.put("meta", JSON.stringify(m));

      // 2. Sandbox with the masked files.
      await sandbox;
      lap("containerMs");
      await this.#sh(`rm -rf ${PROJECT_DIR} ${TASK_DIR} && mkdir -p ${PROJECT_DIR} ${TASK_DIR}/home`);
      for (const [key, text] of Object.entries(masked.texts)) {
        if (!key.startsWith("f:")) continue;
        const path = key.slice(2);
        if (path.includes("/")) await this.#sh(`mkdir -p "$(dirname "$1")"`, [path], PROJECT_DIR);
        await this.#files.writeFile(`${PROJECT_DIR}/${path}`, text);
      }
      for (const [p, text] of Object.entries(req.publicFiles ?? {})) {
        const path = safePath(p);
        if (path.includes("/")) await this.#sh(`mkdir -p "$(dirname "$1")"`, [path], PROJECT_DIR);
        await this.#files.writeFile(`${PROJECT_DIR}/${path}`, text);
      }
      const placeholders = Object.keys((masked.state as { by_ph?: Record<string, unknown> }).by_ph ?? {});
      await this.#files.writeFile(`${PROJECT_DIR}/AGENTS.md`, `${req.rules.trim()}\n${piiRules(placeholders)}`);
      await this.#files.writeFile(`${PROJECT_DIR}/opencode.json`, JSON.stringify(opencodeConfig(req.model, m.maxSteps), null, 1));
      await this.#sh(`find . -type f -printf '%P\\0' | sort -z | xargs -0 -r sha1sum > ${BEFORE_PATH}`, [], PROJECT_DIR);

      lap("filesMs");
      // 3. The agent, in the background, bounded by time.
      const prompt = masked.texts["\u0000prompt"];
      const timeoutSec = Math.min(Math.max(req.timeoutSec ?? 900, 60), 3600);
      const task = await this.#container.exec(
        ["/bin/sh", "-c", TASK_SCRIPT, "agent", "timeout", "-k", "15", String(timeoutSec),
          "opencode", "run", "--format", "json", "--auto", "--model", `openrouter/${req.model.id}`, "--", prompt],
        { cwd: PROJECT_DIR, env: { ...TRUST_ENV, ...OPENCODE_ENV }, stdout: "ignore", stderr: "ignore" },
      );
      await this.#files.writeFile(PID_PATH, String(task.pid));
      await this.ctx.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS);
      lap("launchMs");
      this.ctx.storage.kv.put("timing", JSON.stringify(timing));
      return { state: "started", runId, timing };
    } catch (e) {
      // A half-started run must not leave the mapping behind.
      this.#clear();
      if (this.#container.running) await this.#container.destroy().catch(() => {});
      throw e;
    } finally {
      this.#starting = false;
    }
  }

  async status(): Promise<RunStatus> {
    const done = this.#result();
    if (done) return { state: "done", result: done };
    const meta = this.#meta();
    if (!meta) return { state: "none" };
    if (!this.#container.running || (await this.#exitCode()) !== undefined) {
      await this.#finish();
      const r = this.#result();
      return r ? { state: "done", result: r } : { state: "none" };
    }
    const usage = usageFrom(await this.#readText(EVENTS_PATH) ?? "").usage;
    return { state: "running", runId: meta.runId, startedAt: meta.startedAt, elapsedMs: Date.now() - Date.parse(meta.startedAt), usage };
  }

  // Each check is a request to the container, so it stays awake while the agent runs.
  async alarm(): Promise<void> {
    const meta = this.#meta();
    if (!meta || this.#hasResult()) return;
    if (!this.#container.running || (await this.#exitCode()) !== undefined) {
      await this.#finish();
      return;
    }
    const { usage } = usageFrom(await this.#readText(EVENTS_PATH) ?? "");
    if (usage.costUsd > meta.maxCostUsd) {
      meta.stopReason = "cost_cap";
      this.ctx.storage.kv.put("meta", JSON.stringify(meta));
      await this.#sh("pkill -TERM -f '[o]pencode run' || true");
    }
    await this.ctx.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS);
  }

  // Wakes the sandbox and the masker ahead of a run (called while the request is being planned).
  async warm(name: string): Promise<void> {
    if (this.#starting || this.#finishing) return;
    await Promise.all([this.#ensureContainer(name), this.env.MASKER.getByName("pii").warm()]);
  }

  // Stops a run (if any) and forgets everything: mapping, result, sandbox.
  async cancel(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.#clear();
    if (this.#container.running) await this.#container.destroy();
  }

  #finish(): Promise<void> {
    this.#finishing ||= this.#doFinish().finally(() => { this.#finishing = null; });
    return this.#finishing;
  }

  async #doFinish(): Promise<void> {
    {
      const meta = this.#meta();
      if (!meta || this.#hasResult()) return;
      const vault = JSON.parse(this.ctx.storage.kv.get<string>("vault") ?? "null");
      const finishedAt = new Date().toISOString();
      let result: RunResult;
      if (!this.#container.running) {
        result = {
          runId: meta.runId, state: "lost", stopReason: "lost", error: "the sandbox stopped before the agent finished",
          finalText: "", files: [], skippedFiles: [], unknownPlaceholders: [], alteredPlaceholders: [], piiMasked: meta.piiMasked,
          usage: emptyUsage(), model: meta.model, startedAt: meta.startedAt, finishedAt,
        };
      } else {
        const t0 = Date.now();
        const log = (step: string) => console.log({ event: "project-agent.finish", runId: meta.runId, step, ms: Date.now() - t0 });
        const exitCode = (await this.#exitCode()) ?? -1;
        log("exit-code");
        const ev = usageFrom(await this.#readText(EVENTS_PATH) ?? "");
        log("events");
        const { files, skipped } = await this.#changedFiles();
        log("files");
        // Unmask every text output and the final message in one call.
        const texts: Record<string, string> = { "\u0000final": ev.finalText };
        const keep = new Set(meta.keepMasked ?? []);
        for (const f of files) if (f.encoding === "utf-8" && !keep.has(f.path)) texts[f.path] = f.content;
        const un = await this.env.MASKER.getByName("pii").unmask(texts, vault);
        log("unmask");
        for (const f of files) if (f.encoding === "utf-8" && !keep.has(f.path)) { f.content = un.texts[f.path]; f.size = byteLength(f.content); }
        const stopReason: RunResult["stopReason"] = meta.stopReason
          ?? (exitCode === 124 || exitCode === 137 ? "timeout" : exitCode !== 0 ? "error" : ev.usage.steps >= meta.maxSteps ? "step_cap" : "done");
        // On failure: the end of stderr, else the last events, so the cause is visible to the caller.
        let stderr = "";
        if (exitCode !== 0) {
          stderr = ((await this.#readText(STDERR_PATH)) ?? "").slice(-1500);
          if (!stderr.trim()) stderr = `exit ${exitCode}; last events: ${((await this.#readText(EVENTS_PATH)) ?? "").trim().split("\n").slice(-3).join("\n").slice(-1500)}`;
        }
        result = {
          runId: meta.runId,
          state: exitCode === 0 && stopReason === "done" ? "succeeded" : "failed",
          stopReason,
          error: ev.error ?? (stderr || undefined),
          finalText: un.texts["\u0000final"] ?? "",
          files, skippedFiles: skipped,
          unknownPlaceholders: un.unknown, alteredPlaceholders: un.altered,
          piiMasked: meta.piiMasked, usage: ev.usage, model: meta.model, startedAt: meta.startedAt, finishedAt,
          timing: { ...JSON.parse(this.ctx.storage.kv.get<string>("timing") ?? "{}"), firstStepMs: ev.firstStepAt ? ev.firstStepAt - Date.parse(meta.startedAt) : -1 },
        };
      }
      this.#saveResult(result);
      // The mapping is not needed any more; the sandbox's disk holds only masked data, gone with it.
      this.ctx.storage.kv.delete("vault");
      await this.ctx.storage.deleteAlarm();
      if (this.#container.running) await this.#container.destroy();
    }
  }

  // Files the agent created or changed (by content hash), excluding the runner's own files.
  async #changedFiles(): Promise<{ files: OutputFile[]; skipped: string[] }> {
    const before = new Map<string, string>();
    for (const line of ((await this.#readText(BEFORE_PATH)) ?? "").split("\n")) {
      const [hash, ...rest] = line.split("  ");
      if (hash && rest.length) before.set(rest.join("  "), hash);
    }
    // One line per file: hash, size, path (paths are NUL-separated on the way into the loop).
    const after = await this.#sh(
      `find . -type f -not -path '*/.*' -not -path '*/__pycache__/*' -printf '%P\\0' | sort -z | ` +
        `xargs -0 -r sh -c 'for f; do printf "%s  %s  %s\\n" "$(sha1sum "$f" | cut -c1-40)" "$(stat -c %s "$f")" "$f"; done' sh`,
      [], PROJECT_DIR);
    const files: OutputFile[] = [], skipped: string[] = [];
    let total = 0;
    for (const line of after.stdout.split("\n")) {
      const [hash, sizeText, ...rest] = line.split("  ");
      const path = rest.join("  ");
      if (!hash || !path || RUNNER_FILES.has(path) || before.get(path) === hash) continue;
      if (files.length >= MAX_OUTPUT_FILES) { skipped.push(path); continue; }
      const size = Number(sizeText);
      if (!(size <= MAX_FILE_BYTES) || total + size > MAX_OUTPUT_BYTES) { skipped.push(path); continue; }
      const out = await (await this.#container.exec(["cat", "--", path], { cwd: PROJECT_DIR })).output();
      if (out.exitCode !== 0) { skipped.push(path); continue; }
      const bytes = new Uint8Array(out.stdout);
      total += bytes.byteLength;
      try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        files.push({ path, encoding: "utf-8", content: text, size: bytes.byteLength });
      } catch {
        files.push({ path, encoding: "base64", content: toBase64(bytes), size: bytes.byteLength });
      }
    }
    return { files, skipped };
  }

  async #ensureContainer(name: string): Promise<void> {
    if (this.#container.running) return;
    this.#container.start({
      image: this.#container.images.sandbox,
      // 1 vCPU: the agent's own startup on half a core was 11-15 s before its first step.
      instance: "standard-2",
      enableInternet: false,
      labels: { app: "whisp-project-agent", sandbox: name },
    });
    // Intercepts last for this container run, so install them once per start.
    await this.#container.interceptAllOutboundHttp(this.#outbound);
    await this.#container.interceptOutboundHttps("*", this.#outbound);
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  async #exitCode(): Promise<number | undefined> {
    if (!this.#container.running) return undefined;
    const t = await this.#readText(EXIT_CODE_PATH);
    if (t !== undefined) return Number.parseInt(t, 10);
    if ((await this.#readText(PID_PATH)) === undefined) return undefined;
    // By process name, not the exec pid: that pid need not be visible in the container's namespace.
    // The brackets keep pgrep from matching this probe's own command line.
    const probe = await this.#sh("pgrep -f '[o]pencode run' >/dev/null");
    if (probe.exitCode === 0) return undefined;
    const late = await this.#readText(EXIT_CODE_PATH);
    return late !== undefined ? Number.parseInt(late, 10) : -1;
  }

  // Reads go through exec (cat), not Files.readFile, which can hang waiting for its stderr control
  // header (sandbox-sdk #935, 1.0.0).
  async #readText(path: string): Promise<string | undefined> {
    const out = await (await this.#container.exec(["/bin/sh", "-c", 'test -f "$1" && cat -- "$1"', "sh", path])).output();
    return out.exitCode === 0 ? new TextDecoder().decode(out.stdout) : undefined;
  }

  async #sh(script: string, args: string[] = [], cwd = "/"): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const p = await this.#container.exec(["/bin/sh", "-c", script, "sh", ...args], { cwd });
    const out = await p.output();
    const d = new TextDecoder();
    return { exitCode: out.exitCode, stdout: d.decode(out.stdout), stderr: d.decode(out.stderr) };
  }

  #meta(): Meta | null {
    const s = this.ctx.storage.kv.get<string>("meta");
    return s ? (JSON.parse(s) as Meta) : null;
  }

  #hasResult(): boolean {
    return this.ctx.storage.kv.get("result:n") !== undefined;
  }

  #saveResult(r: RunResult): void {
    const s = JSON.stringify(r);
    const n = Math.ceil(s.length / CHUNK) || 1;
    for (let i = 0; i < n; i++) this.ctx.storage.kv.put(`result:${i}`, s.slice(i * CHUNK, (i + 1) * CHUNK));
    this.ctx.storage.kv.put("result:n", n);
  }

  #result(): RunResult | null {
    const n = this.ctx.storage.kv.get<number>("result:n");
    if (n === undefined) return null;
    let s = "";
    for (let i = 0; i < n; i++) s += this.ctx.storage.kv.get<string>(`result:${i}`) ?? "";
    return JSON.parse(s) as RunResult;
  }

  #clear(): void {
    for (const [k] of Array.from(this.ctx.storage.kv.list())) this.ctx.storage.kv.delete(k);
  }
}

function opencodeConfig(model: ModelSpec, steps: number): unknown {
  return {
    $schema: "https://opencode.ai/config.json",
    model: `openrouter/${model.id}`,
    small_model: `openrouter/${model.id}`,
    enabled_providers: ["openrouter"],
    provider: {
      openrouter: {
        models: {
          [model.id]: {
            name: model.name ?? model.id,
            tool_call: true,
            temperature: true,
            reasoning: false,
            limit: { context: model.context ?? 1_000_000, output: model.output ?? 65_536 },
            cost: model.cost,
            // A fixed provider (and its fp8 weights) for every step: OpenRouter otherwise rotates across ~40
            // deepseek providers with different quantisations (2026-10-30, src/llm/pin.ts on the server).
            options: model.id.startsWith("deepseek/") ? { provider: { order: ["deepinfra", "novita", "nebius"], quantizations: ["fp8"], allow_fallbacks: true }, seed: 7 } : {},
          },
        },
      },
    },
    permission: { edit: "allow", bash: "allow", webfetch: "deny" },
    share: "disabled",
    autoupdate: false,
    agent: { build: { steps, temperature: 0 } },
  };
}

function emptyUsage(): RunUsage {
  return { steps: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, toolCalls: 0, toolErrors: 0 };
}

// opencode --format json: one event per line. step_finish carries tokens and cost; the last text part
// is the agent's final message; error events explain a failure.
function usageFrom(events: string): { usage: RunUsage; finalText: string; error?: string; firstStepAt?: number } {
  const usage = emptyUsage();
  let finalText = "";
  let error: string | undefined;
  let firstStepAt: number | undefined;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const part = e?.part ?? {};
    if (e.type === "step_start" && firstStepAt === undefined && Number(e.timestamp)) firstStepAt = Number(e.timestamp);
    if (e.type === "step_finish") {
      usage.steps++;
      usage.costUsd += Number(part.cost) || 0;
      const t = part.tokens ?? {};
      usage.tokensIn += Number(t.input) || 0;
      usage.tokensOut += (Number(t.output) || 0) + (Number(t.reasoning) || 0);
      usage.tokensCached += Number(t.cache?.read) || 0;
    } else if (e.type === "tool_use") {
      usage.toolCalls++;
      if (part.state?.status === "error") usage.toolErrors++;
    } else if (e.type === "text" && typeof part.text === "string") {
      finalText = part.text;
    } else if (e.type === "error") {
      error = String(e.error?.data?.message ?? e.error?.name ?? "error");
    }
  }
  usage.costUsd = Math.round(usage.costUsd * 1e6) / 1e6;
  return { usage, finalText, error, firstStepAt };
}

// Relative path inside the project, no "..", no leading "/".
export function safePath(p: string): string {
  const parts = p.split("/").filter((s) => s && s !== "." && s !== "..");
  if (!parts.length) throw new TypeError(`bad path: ${p}`);
  return parts.join("/").slice(0, 200);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
