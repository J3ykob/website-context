/**
 * The planner: before the agent works, a system step turns the request into a frozen specification
 * (plan.json) - what the result is for, the task-specific instructions for the harness, which inputs to
 * use, which outputs to produce (path, format, audience) and the acceptance criteria. No human takes part;
 * the planner never sees or judges results. The agent executes the spec (it is the harness's system
 * prompt), and verification checks the outputs against it. Changes (an owner's note, other businesses'
 * answers) produce a new version of the spec, never free-form instructions.
 *
 * Token budget: the planner reads a compact inventory (file names, sizes, CSV headers, the network
 * directory's first lines, the recent conversation) - never whole files.
 */
import { REQUESTS_FILE } from "./network.js";
import { getProject, setMemory, addEvent } from "./store.js";
import { listFiles, readFile, writeFile } from "./repo.js";

export type Audience = "customer" | "business" | "internal";
export interface Output { path: string; format: "txt" | "md" | "csv" | "json"; audience: Audience; description: string }
export interface Spec {
  version: number;
  request: string; // the requester's latest message, verbatim (set by code, never by the model)
  goal: string;
  language: string;
  facts: string[];
  inputs: { path: string; use: string }[];
  outputs: Output[];
  acceptance: string[];
  instructions: string;
  basis?: string; // what this version changed (owner's note, businesses' answers)
}

export type ProjectKind = "customer" | "business_request";
const CUSTOMER_DIR = "dla_klienta";
const MAX_FACTS = 15, MAX_INPUTS = 20, MAX_OUTPUTS = 8, MAX_ACCEPT = 8;

async function inventory(projectId: string): Promise<{ text: string; paths: Set<string> }> {
  const files = await listFiles(projectId);
  const paths = new Set(files.map((f) => f.path));
  const shown = files.filter((f) => !f.path.startsWith("agent/") && !f.path.startsWith("historia/") && f.path !== "plan.json" && !f.path.startsWith("plan/"));
  // CSV headers and row counts, read in parallel.
  const notes = await Promise.all(shown.map(async (f) => {
    if (f.kind !== "csv") return "";
    const t = (await readFile(projectId, f.path).catch(() => null)) || "";
    const rows = t.split("\n").filter((l) => l.trim());
    return ` - ${Math.max(0, rows.length - 1)} wierszy, kolumny: ${(rows[0] || "").replace("\uFEFF", "").slice(0, 200)}`;
  }));
  return { text: shown.map((f, k) => `- ${f.path} (${f.size} B)${notes[k]}`).join("\n"), paths };
}

const SYSTEM = `You plan work for an autonomous agent that will run in a sandbox with a shell, python and the project's files.
You do NOT do the work and you never see results. You write a precise specification the agent will follow.

Return ONLY a JSON object:
{
 "goal": "one sentence: what the result is for",
 "language": "language of the text for the customer (pl, en, uk, fr, de, ...)",
 "facts": ["requirements the requester stated: quantities, sizes, dates, budget, constraints - copied, not invented"],
 "inputs": [{"path": "existing file from the inventory", "use": "what to take from it"}],
 "outputs": [{"path": "file to produce", "format": "txt|md|csv|json", "audience": "customer|business|internal", "description": "exact content and structure (for csv: the columns)"}],
 "acceptance": ["checkable criteria the outputs must meet"],
 "instructions": "task-specific guidance for the agent, max 1200 characters: the method, the order of steps, what to watch out for"
}
Rules:
- Only what the request needs. No outputs nobody asked for or needs.
- The text for the requester is always odpowiedz.txt (audience customer for a customer, business for a business).
- A file for the customer only when the result is something they will keep or work with: a cost sheet or
  list with several items, a comparison table, a plan or document. A short answer (one item, one price, a
  simple choice) stays in odpowiedz.txt alone - no file. Customer files go to ${CUSTOMER_DIR}/ (csv for
  tables, md for documents).
- Inputs: only files listed in the inventory.
- Facts: only what was stated, copied in the requester's own words and language (quote them); never translate,
  paraphrase or rename products or terms - a wrong rewording changes the request. If something essential is
  missing, the agent will use a stated, reasonable assumption - do not invent values here.
- Goal: describe the request without naming products in other words than the requester used.
- Acceptance: one checkable fact about the CONTENT per criterion (what the result must contain or satisfy),
  e.g. "the reply names the heaviest compactor that fits the 500 PLN budget". Never criteria about language,
  tone, format, headers or file names - those are checked separately.
- Acceptance: must be achievable with the data that exists - a part the data does not price or settle is
  marked as to be quoted / unknown, and the criteria must accept that (e.g. "each line has a value or the
  status do_wyceny", never "each line has a price"). Concrete and checkable (e.g. "every requested item appears in the table with a value or status do_wyceny", "the total equals the sum of the priced lines").`;

/** Validates the planner's JSON against the inventory; repairs what code can, reports the rest. */
export function validateSpec(raw: any, kind: ProjectKind, paths: Set<string>): { spec: Omit<Spec, "version" | "request">; problems: string[] } {
  const problems: string[] = [];
  const str = (v: any, max: number) => String(v ?? "").trim().slice(0, max);
  const safe = (p: string) => p.split("/").filter((s) => s && s !== "." && s !== "..").join("/");
  const facts = (Array.isArray(raw?.facts) ? raw.facts : []).map((x: any) => str(x, 300)).filter(Boolean).slice(0, MAX_FACTS);
  const inputs = (Array.isArray(raw?.inputs) ? raw.inputs : []).map((x: any) => ({ path: safe(str(x?.path, 200)), use: str(x?.use, 300) }))
    .filter((x: any) => { if (!paths.has(x.path)) { if (x.path) problems.push(`input ${x.path} does not exist`); return false; } return true; }).slice(0, MAX_INPUTS);
  const audienceOk = (a: string): a is Audience => a === "customer" || a === "business" || a === "internal";
  const outputs: Output[] = [];
  for (const x of Array.isArray(raw?.outputs) ? raw.outputs : []) {
    const path = safe(str(x?.path, 200));
    const ext = path.split(".").pop() as Output["format"];
    if (!path || !["txt", "md", "csv", "json"].includes(ext)) { problems.push(`output ${path || "(empty)"} must be .txt/.md/.csv/.json`); continue; }
    const audience = audienceOk(x?.audience) ? x.audience : "internal";
    if (audience === "customer" && path !== "odpowiedz.txt" && !path.startsWith(`${CUSTOMER_DIR}/`)) { problems.push(`customer file ${path} must be in ${CUSTOMER_DIR}/`); continue; }
    if (outputs.some((o) => o.path === path)) continue;
    outputs.push({ path, format: ext, audience, description: str(x?.description, 600) });
  }
  const replyAudience: Audience = kind === "business_request" ? "business" : "customer";
  if (!outputs.some((o) => o.path === "odpowiedz.txt")) outputs.unshift({ path: "odpowiedz.txt", format: "txt", audience: replyAudience, description: "the message to the requester" });
  const acceptance = (Array.isArray(raw?.acceptance) ? raw.acceptance : []).map((x: any) => str(x, 300)).filter(Boolean).slice(0, MAX_ACCEPT);
  const goal = str(raw?.goal, 300);
  if (!goal) problems.push("goal is empty");
  return {
    spec: { goal, language: str(raw?.language, 10), facts, inputs, outputs: outputs.slice(0, MAX_OUTPUTS), acceptance, instructions: str(raw?.instructions, 1200) },
    problems,
  };
}

function parseJson(t: string): any {
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

async function llm(system: string, user: string): Promise<string> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(Number(process.env.PLANNER_TIMEOUT_MS) || 90_000),
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.PLANNER_MODEL || "deepseek/deepseek-v4.1-flash", temperature: 0, max_tokens: 4000, response_format: { type: "json_object" }, provider: { sort: "throughput" },
      // No hidden reasoning: it multiplies latency and can eat the token budget before any JSON is written.
      // Benchmark 2026-10-13 (4 real requests): deepseek-v4.1-flash without reasoning 10-20 s and faithful to the
      // requester's words; qwen3-235b 22-39 s and mistranslated product names.
      reasoning: JSON.parse(process.env.PLANNER_REASONING || '{"enabled":false}'), messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`planner ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as any;
  const content = j.choices?.[0]?.message?.content || "";
  if (!parseJson(content)) console.warn(`[plan] unusable planner reply: provider=${j.provider} finish=${j.choices?.[0]?.finish_reason} len=${content.length} out=${j.usage?.completion_tokens}`);
  return content;
}

/**
 * Plans (or re-plans) the project's work. `brief`: what is asked (the system's own words for the kind of
 * work); `change`: why a new version is needed (owner's note, businesses' answers). Returns the spec and
 * stores it (plan.json + plan/v<n>.json, memory.plan, event "planned").
 */
export async function plan(projectId: string, brief: string, kind: ProjectKind, change?: string): Promise<Spec> {
  const project = await getProject(projectId);
  if (!project) throw new Error("project not found");
  const prev = project.memory.plan as Spec | undefined;
  const [inv, convo, req0, firmsRaw] = await Promise.all([
    inventory(projectId),
    readFile(projectId, "rozmowa.md").catch(() => null),
    readFile(projectId, "request.txt").catch(() => null),
    readFile(projectId, "cenniki/firmy.md").catch(() => null),
  ]);
  const conversation = (convo || req0 || "").slice(-4000);
  const firms = (firmsRaw || "").split("\n").filter((l) => l.startsWith("## ")).join("\n");
  const user = [
    `KIND: ${kind === "business_request" ? "a request from another business of the network (the requester is that business)" : "a customer's request in a chat with the business"}`,
    `BRIEF: ${brief}`,
    `CONVERSATION (latest part):\n${conversation}`,
    firms ? `BUSINESSES OF THE NETWORK (details in cenniki/firmy.md):\n${firms}` : "",
    `INVENTORY (project files):\n${inv.text}`,
    prev && change ? `CURRENT SPEC (v${prev.version}):\n${JSON.stringify({ ...prev, version: undefined })}\n\nCHANGE TO APPLY (keep everything else):\n${change}` : "",
  ].filter(Boolean).join("\n\n");
  let raw = parseJson(await llm(SYSTEM, user));
  let v = validateSpec(raw, kind, inv.paths);
  if (v.problems.length || !raw) {
    raw = parseJson(await llm(SYSTEM, `${user}\n\nYOUR PREVIOUS ANSWER HAD PROBLEMS - fix them:\n${v.problems.join("\n") || "not valid JSON"}`)) || raw;
    v = validateSpec(raw, kind, inv.paths);
  }
  // An empty or unparseable spec is a planning failure (the caller retries, then runs on the plain
  // request) - never a vacuous spec with defaults the agent would follow.
  if (!raw || !v.spec.goal) throw new Error(`no usable spec (${v.problems.join("; ") || "not valid JSON"})`);
  const request = (req0 || "").trim().slice(0, 3000);
  // Businesses that came in for this request without prices for it (cenniki/firmy.md): writing the
  // requests to them is part of the result, not left to the agent's discretion (an empty list when the
  // customer did not ask for their part). Only in the first round - after the answers, nobody is asked again.
  const mustAsk = kind === "customer" && !project.memory.networkAsked && (firmsRaw || "").includes("trzeba zapytać firmę");
  if (mustAsk && !v.spec.outputs.some((o) => o.path === REQUESTS_FILE)) {
    v.spec.outputs.push({ path: REQUESTS_FILE, format: "json", audience: "internal", description: `Zapytania do firm z sieci (zasada 9): [{"firma": "<identyfikator z cenniki/firmy.md>", "pytanie": "..."}] - o części, o które prosi klient, a których ceny nie ma w danych; [] gdy takich części nie ma.` });
  }
  const spec: Spec = { version: (prev?.version || 0) + 1, request, ...v.spec, ...(change ? { basis: change.slice(0, 1000) } : {}) };
  const body = JSON.stringify(spec, null, 1);
  await Promise.all([
    writeFile(projectId, "plan.json", body, "json", "planner"),
    writeFile(projectId, `plan/v${spec.version}.json`, body, "json", "planner"),
    setMemory(projectId, { plan: spec }),
  ]);
  await addEvent(projectId, { kind: "planned", actor: "planner", data: { version: spec.version, goal: spec.goal, outputs: spec.outputs.map((o) => o.path), acceptance: spec.acceptance.length, change: change?.slice(0, 300) } });
  return spec;
}

/** The spec as the harness's system prompt section (AGENTS.md). */
export function renderSpec(s: Spec): string {
  const out = s.outputs.map((o) => `- ${o.path} [${o.format}, dla: ${o.audience === "customer" ? "klienta" : o.audience === "business" ? "firmy pytającej" : "wewnętrzny"}] - ${o.description}`).join("\n");
  return `
## Specyfikacja zadania (v${s.version}) - wykonaj dokładnie
${s.request ? `Prośba zlecającego (dosłownie - rozstrzyga w razie rozbieżności z poniższym streszczeniem; nazwy produktów rozumiej tak, jak je napisał):\n"""\n${s.request}\n"""\n` : ""}Cel: ${s.goal}
Język tekstu dla odbiorcy: ${s.language || "język zlecającego (jak w jego prośbie)"}
${s.facts.length ? `Wymagania podane przez zlecającego:\n${s.facts.map((f) => `- ${f}`).join("\n")}\n` : ""}${s.inputs.length ? `Dane wejściowe:\n${s.inputs.map((i) => `- ${i.path}: ${i.use}`).join("\n")}\n` : ""}Wyniki (dokładnie te pliki):
${out}
${s.acceptance.length ? `Kryteria akceptacji (sprawdzane po Twojej pracy):\n${s.acceptance.map((a) => `- ${a}`).join("\n")}\n` : ""}${s.instructions ? `Wskazówki:\n${s.instructions}\n` : ""}${s.basis ? `Ta wersja uwzględnia: ${s.basis}\n` : ""}`;
}

/**
 * Plan, then run: the project's inputs (offers, network directory) are put in place, the planner writes
 * the spec (a new version when `change` is given), and the agent executes it.
 */
export async function planAndRun(projectId: string, brief: string, actor: string, change?: string): Promise<{ runId: string } | { error: string }> {
  const { prepareInputs, startAgentRun, warmRunner } = await import("./agent.js");
  // Containers start now, in parallel with preparing and planning (~10-25 s of cold start hidden).
  warmRunner(projectId);
  const { BUSINESS_REQUEST } = await import("./network.js");
  const p = await getProject(projectId);
  if (!p) return { error: "Project not found." };
  const t0 = Date.now();
  await prepareInputs(projectId);
  const prepareMs = Date.now() - t0;
  // Planning must not cost the customer the result: one retry (transient model / D1 errors), then the
  // agent runs on the brief alone (the previous spec, if any, is dropped so it cannot mislead).
  const kind = p.type === BUSINESS_REQUEST ? "business_request" : "customer";
  let planned = false;
  for (let attempt = 1; attempt <= 2 && !planned; attempt++) {
    try {
      await plan(projectId, brief, kind, change);
      planned = true;
    } catch (e) {
      console.warn(`[plan] ${projectId}: attempt ${attempt} failed: ${(e as Error).message}`);
      if (attempt === 1) await new Promise((ok) => setTimeout(ok, 3000));
    }
  }
  if (!planned) {
    await setMemory(projectId, { plan: null }).catch(() => {});
    await addEvent(projectId, { kind: "plan_failed", actor: "planner", data: {} }).catch(() => {});
  }
  const planMs = Date.now() - t0 - prepareMs;
  const r = await startAgentRun(projectId, planned ? "" : [brief, change].filter(Boolean).join("\n\n"), actor, 1, undefined, undefined, { prepareMs, planMs });
  return "error" in r ? r : { runId: r.runId };
}
