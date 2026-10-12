/**
 * The project agent: a coding agent (opencode + a cheap model via OpenRouter) that works in a project's
 * repository with full tools - shell, python, files - in a Cloudflare sandbox (workers/project-agent).
 *
 *   1. start: the repository's files (customer data -> masked by the runner before the sandbox sees them)
 *      plus the participating businesses' offers as price lists (public data, not masked) and the rules
 *      (AGENTS.md) go to the runner. One run per project at a time.
 *   2. the runner masks personal data, runs the agent, unmasks its outputs (placeholder mapping never
 *      enters the sandbox) - workers/project-agent/src/agent.ts.
 *   3. collect (polling here, or lazily on a status request after a restart): outputs go into the
 *      repository (author "agent:<model>"), usage into the project, then code + Jev verify them as
 *      requirements (sys-agent-*). A failed run is retried once on the fallback model.
 *
 * Numbers in anything the customer reads must come from files (prices, computed totals); the checks
 * enforce it. Env: PROJECT_AGENT_URL, PROJECT_AGENT_SECRET, PROJECT_AGENT_MODEL, PROJECT_AGENT_FALLBACK_MODEL.
 */
import { getProject, setMemory, addEvent, addUsage, listParticipants, type Project } from "./store.js";
import { listFiles, readFile, writeFile, writeBinaryFile, addRequirement, listRequirements, recordVerification, toCsv, type FileKind, type ReqStatus } from "./repo.js";
import { loadOffer, priceText, type OfferItem } from "../offer/store.js";
import { FIELDS } from "../offer/schema.js";
import { jevAsk } from "../llm/jev.js";
import { getTenant } from "../multi-tenant/d1-registry.js";

export interface ModelSpec { id: string; name: string; cost: { input: number; output: number; cache_read?: number } }

// USD per million tokens (OpenRouter, 2026-10-12). Benchmarked on 25 real project tasks x 4 runs:
// DeepSeek V4.1 Flash 97/100 (p50 27 s, ~$0.01/task), MiMo-V2.6-Flash slower and cheaper.
export const MODELS: Record<string, ModelSpec> = {
  "deepseek/deepseek-v4.1-flash": { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
  "xiaomi/mimo-v2.6-flash": { id: "xiaomi/mimo-v2.6-flash", name: "MiMo-V2.6-Flash", cost: { input: 0.14, output: 0.28, cache_read: 0.0028 } },
};
const primaryModel = () => MODELS[process.env.PROJECT_AGENT_MODEL || ""] || MODELS["deepseek/deepseek-v4.1-flash"];
const fallbackModel = () => MODELS[process.env.PROJECT_AGENT_FALLBACK_MODEL || ""] || MODELS["xiaomi/mimo-v2.6-flash"];

const POLL_MS = 10_000;
const PRICE_DIR = "cenniki";
const MAX_RUN_MS = 20 * 60 * 1000;
const MAX_INPUT_FILE = 512 * 1024;
const LANGS: Record<string, string> = { pl: "Polish", en: "English", uk: "Ukrainian", fr: "French", de: "German", other: "another language" };

export interface AgentRunState {
  runId: string;
  model: string;
  instruction: string;
  status: "running" | "collecting" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  attempt: number;
  stopReason?: string;
  error?: string;
  files?: string[];
  verification?: { met: number; failed: number };
  costUsd?: number;
}

export function agentEnabled(): boolean {
  return !!(process.env.PROJECT_AGENT_URL && process.env.PROJECT_AGENT_SECRET);
}

async function runner(path: string, init: RequestInit = {}, timeoutMs = 180_000): Promise<Response> {
  let base = process.env.PROJECT_AGENT_URL || "";
  while (base.endsWith("/")) base = base.slice(0, -1);
  return fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${process.env.PROJECT_AGENT_SECRET}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

// General working rules for any project (a quote, a comparison, an order list, a schedule, an analysis,
// a document...). What to deliver comes from the task; these say how to work. Anything specific to one
// kind of project belongs in its task text, not here.
const RULES = `# Agent projektu Whisp

Pracujesz w repozytorium projektu (bieżący katalog): to są wszystkie dane projektu - wiadomości klienta,
wcześniejsze wyniki, notatki. Oferty firm biorących udział w projekcie są w cenniki/ (opis formatu: cenniki/README.md).
Klient ani firma nie odpowiedzą w trakcie pracy - nie zadawaj pytań. Gdy czegoś brakuje albo coś jest niejasne,
przyjmij najrozsądniejsze założenie, zapisz je w zalozenia.md i oznacz w wynikach jako założenie.

Zasady:
1. Fakty tylko z danych. Ceny, terminy, dostępność, warunki, nazwy - wyłącznie z plików repozytorium.
   Niczego nie wymyślaj. Czego nie ma w danych, oznacz wprost jako nieznane / do ustalenia (np. status "do_wyceny").
2. Każde obliczenie (sumy, ilości, przeliczenia jednostek, daty, porównania) wykonuj kodem (python3) i zostaw
   skrypt w repozytorium. Nigdy nie licz w pamięci. Każda liczba w wynikach musi wynikać z danych albo z obliczenia.
3. Nazwy z danych (pozycje, firmy) przepisuj dokładnie, bez tłumaczenia - także w tekstach w innym języku.
4. Pliki, o które prosi zadanie, zapisz dokładnie pod podanymi nazwami i w podanym formacie.
   Domyślnie: tabele jako CSV (separator ";", kropka dziesiętna, nagłówek w pierwszym wierszu), teksty jako .md lub .txt,
   dane dla programów jako .json. Nie twórz plików binarnych (xlsx, pdf) - arkusze i dokumenty tworzy system.
5. Tekst dla klienta (gdy zadanie o niego prosi; domyślnie odpowiedz.txt) pisz w JĘZYKU KLIENTA - języku jego wiadomości.
   Krótko i konkretnie; tylko to, co wynika z danych i obliczeń; wyraźnie wskaż, co jest nieznane lub do ustalenia;
   bez obietnic, których nie ma w danych.
6. Gdy kilka firm oferuje to samo, porównuj na tych samych warunkach (ilość, okres, jednostka) i wyjaśnij wybór.
7. Sprawdź swoje wyniki przed zakończeniem (np. czy sumy się zgadzają, czy każda pozycja z zadania jest ujęta).
   Na końcu napisz krótko, co zrobiłeś i jakie pliki powstały.
`;

// cenniki/README.md: how the offer files are laid out (general, for any business type).
const PRICE_README = `# Oferty firm

Dla każdej firmy:
- cennik_<firma>.csv - pozycje oferty: id, nazwa, kategoria, cena (opis ceny), cena_od, cena_do, waluta, jednostka,
  dostepnosc, czas_realizacji, opis. Pusta cena = brak ceny w ofercie (do ustalenia z firmą).
- skladniki_<firma>.csv (jeśli są) - pozycje, których cena składa się z kilku części: id_pozycji, pozycja, skladnik,
  cena, cena_do, jednostka, polaczenie, ilosc_od_klienta.
  polaczenie = "suma": części się sumują (np. robocizna + materiał);
  polaczenie = "do_wyboru": klient płaci jedną z nich (np. stawka godzinowa albo dobowa) - wybierz tę, która przy
  danej ilości jest najkorzystniejsza dla klienta (doba = 24 h).
  ilosc_od_klienta: czego ilość podaje klient (np. metraż) - jeśli jej nie podał, to jest założenie albo "do ustalenia".
`;

/** Offers of the businesses in the project as CSV price lists (public data). */
async function priceLists(project: Project, tenantIds: string[]): Promise<{ files: Record<string, string>; allow: string[]; catalog: string[] }> {
  const files: Record<string, string> = {};
  const allow: string[] = [];
  const catalog = new Set<string>();
  const used = new Set<string>();
  for (const tenantId of tenantIds) {
    const offer = await loadOffer(tenantId).catch(() => null);
    const t = getTenant(tenantId);
    const label = t?.settings?.siteCard?.brand || t?.brandName || t?.domain || tenantId;
    allow.push(label, t?.domain || "", t?.siteUrl || "");
    if (!offer?.items.length) continue;
    let slug = fileSlug(label) || fileSlug(tenantId);
    while (used.has(slug)) slug += "_";
    used.add(slug);
    const unit = (u?: string) => (u && u !== "unknown" ? FIELDS.unit.values[u]?.label || u : "");
    const val = (f: keyof typeof FIELDS, v?: string) => (v && v !== "unknown" ? (FIELDS[f].values as any)[v]?.label || v : "");
    files[`cennik_${slug}.csv`] = toCsv(
      ["id", "nazwa", "kategoria", "cena", "cena_od", "cena_do", "waluta", "jednostka", "dostepnosc", "czas_realizacji", "opis"],
      offer.items.map((i: OfferItem) => [i.id.slice(0, 8), i.name, i.category, priceText(i) || (i.components.some((c) => c.price_value !== null) ? "patrz skladniki" : ""), i.price_value, i.price_max, i.currency,
        unit(i.fields.unit), val("availability", i.fields.availability), val("lead_time", i.fields.lead_time), i.description.slice(0, 300)]),
    ).slice(1); // no BOM: the agent reads these with python
    const comps = offer.items.flatMap((i) => i.components.map((c) => [i.id.slice(0, 8), i.name, c.label, c.price_value, c.price_max, unit(c.unit), c.combine === "sum" ? "suma" : "do_wyboru", c.quantity_from === "customer" ? c.quantity_label || "tak" : ""]));
    if (comps.length) files[`skladniki_${slug}.csv`] = toCsv(["id_pozycji", "pozycja", "skladnik", "cena", "cena_do", "jednostka", "polaczenie", "ilosc_od_klienta"], comps).slice(1);
    for (const i of offer.items) for (const w of i.name.split(" ")) if (w.length > 2) catalog.add(w);
  }
  void project;
  return { files, allow: allow.filter(Boolean), catalog: [...catalog].slice(0, 3000) };
}

const withoutBom = (t: string) => (t.startsWith("\uFEFF") ? t.slice(1) : t);

function fileSlug(s: string): string {
  const map: Record<string, string> = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };
  let out = "";
  for (const ch of s.toLowerCase()) {
    const c = map[ch] ?? ch;
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) out += c;
    else if (out && !out.endsWith("_")) out += "_";
  }
  while (out.endsWith("_")) out = out.slice(0, -1);
  return out.slice(0, 40);
}

/** Starts the agent on a project. Returns the run state, or an error message when it cannot start. */
export async function startAgentRun(projectId: string, instruction: string, actor: string, attempt = 1, model = primaryModel()): Promise<AgentRunState | { error: string }> {
  if (!agentEnabled()) return { error: "The project agent is not configured." };
  const project = await getProject(projectId);
  if (!project) return { error: "Project not found." };
  const prev = project.memory.agentRun as AgentRunState | undefined;
  if (prev && (prev.status === "running" || prev.status === "collecting") && Date.now() - Date.parse(prev.startedAt) < MAX_RUN_MS) return { error: "The agent is already working on this project." };

  // The businesses' current offers become part of the repository (what the agent priced from), sent
  // unmasked: they are public data. Everything else may hold customer data and is masked by the runner.
  const tenantIds = [...new Set([project.initiatorTenantId, ...(await listParticipants(projectId)).map((p) => p.tenantId)])];
  const offers = await priceLists(project, tenantIds);
  for (const [name, body] of Object.entries(offers.files)) await writeFile(projectId, `${PRICE_DIR}/${name}`, body, "csv", "system");
  if (Object.keys(offers.files).length) await writeFile(projectId, `${PRICE_DIR}/README.md`, PRICE_README, "md", "system");
  const files: Record<string, string> = {};
  const publicFiles: Record<string, string> = {};
  for (const f of await listFiles(projectId)) {
    if (f.size > MAX_INPUT_FILE || f.kind === "bin") continue;
    const body = await readFile(projectId, f.path);
    if (body === null) continue;
    if (f.path.startsWith(`${PRICE_DIR}/`)) publicFiles[f.path] = withoutBom(body);
    else files[f.path] = withoutBom(body);
  }
  const prompt = `Zadanie projektu "${project.title || project.type}":\n${instruction}\n\nZasady pracy są w AGENTS.md.`;

  const r = await runner(`/projects/${encodeURIComponent(projectId)}/run`, {
    method: "POST",
    body: JSON.stringify({ prompt, rules: RULES, files, publicFiles, model, maxSteps: 60, timeoutSec: 900, maxCostUsd: 0.5, allow: offers.allow, catalog: offers.catalog }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e?.message || e) }) as unknown as Response);
  if (r.status === 409) return { error: "The agent is already working on this project." };
  if (!r.ok) return { error: `The agent could not start (${r.status}): ${(await r.text()).slice(0, 200)}` };
  const { runId } = (await r.json()) as { runId: string };
  const state: AgentRunState = { runId, model: model.id, instruction: instruction.slice(0, 2000), status: "running", startedAt: new Date().toISOString(), attempt };
  await setMemory(projectId, { agentRun: state });
  await addEvent(projectId, { kind: "agent_started", actor, data: { runId, model: model.id, attempt, files: Object.keys(files), priceLists: Object.keys(publicFiles) } });
  void poll(projectId, runId);
  return state;
}

const polling = new Set<string>();
async function poll(projectId: string, runId: string): Promise<void> {
  if (polling.has(runId)) return;
  polling.add(runId);
  try {
    const deadline = Date.now() + MAX_RUN_MS;
    while (Date.now() < deadline) {
      await new Promise((ok) => setTimeout(ok, POLL_MS));
      const s = await agentStatus(projectId).catch(() => null);
      if (!s || s.runId !== runId || s.status === "done" || s.status === "failed") return;
    }
  } finally {
    polling.delete(runId);
  }
}

/**
 * The run's state; when the runner has finished, collects the result (once) - so a run survives a
 * restart of this server: the next status request finishes it.
 */
export async function agentStatus(projectId: string): Promise<AgentRunState | null> {
  const project = await getProject(projectId);
  const state = project?.memory.agentRun as AgentRunState | undefined;
  if (!project || !state || state.status === "done" || state.status === "failed") return state || null;
  if (state.status === "collecting" && Date.now() - Date.parse(state.finishedAt || state.startedAt) < 120_000) return state;
  const r = await runner(`/projects/${encodeURIComponent(projectId)}/run`, { method: "GET" }, 60_000);
  if (!r.ok) return state;
  const s = (await r.json()) as any;
  if (s.state === "running") return state;
  if (s.state === "none" || s.result?.runId !== state.runId) {
    const failed: AgentRunState = { ...state, status: "failed", error: "The run was lost.", finishedAt: new Date().toISOString() };
    await setMemory(projectId, { agentRun: failed });
    return failed;
  }
  const collecting: AgentRunState = { ...state, status: "collecting", finishedAt: new Date().toISOString() };
  await setMemory(projectId, { agentRun: collecting });
  return collect(project, collecting, s.result);
}

interface RunResult {
  runId: string; state: "succeeded" | "failed" | "lost"; stopReason: string; error?: string; finalText: string;
  files: { path: string; encoding: "utf-8" | "base64"; content: string; size: number }[];
  skippedFiles: string[]; unknownPlaceholders: string[]; alteredPlaceholders: string[]; piiMasked: number;
  usage: { steps: number; costUsd: number; toolCalls: number; toolErrors: number };
}

async function collect(project: Project, state: AgentRunState, result: RunResult): Promise<AgentRunState> {
  const id = project.id;
  const author = `agent:${state.model}`;
  const written: string[] = [];
  for (const f of result.files) {
    try {
      if (f.encoding === "base64") await writeBinaryFile(id, f.path, Buffer.from(f.content, "base64"), author);
      else await writeFile(id, f.path, f.content, kindOf(f.path), author);
      written.push(f.path);
    } catch (e: any) {
      console.warn(`[project-agent] ${id} could not store ${f.path}: ${e?.message || e}`);
    }
  }
  await writeFile(id, "agent/raport.md", report(state, result), "md", "system").catch(() => {});
  await addUsage(id, { llmCalls: result.usage.steps, costUsd: result.usage.costUsd }).catch(() => {});
  await addEvent(id, { kind: "agent_finished", actor: author, data: { runId: result.runId, state: result.state, stopReason: result.stopReason, files: written, usage: result.usage, piiMasked: result.piiMasked } });
  // Release the runner's copy (result and mapping are gone afterwards).
  await runner(`/projects/${encodeURIComponent(id)}/run`, { method: "DELETE" }, 30_000).catch(() => {});

  const verification = await verifyOutputs(id, result, state.instruction).catch((e) => {
    console.warn(`[project-agent] ${id} verification error: ${e?.message || e}`);
    return null;
  });
  const ok = result.state === "succeeded" && result.unknownPlaceholders.length === 0 && result.alteredPlaceholders.length === 0 && !verification?.failed;
  const done: AgentRunState = {
    ...state, status: ok ? "done" : "failed", stopReason: result.stopReason, error: result.error?.slice(0, 500),
    files: written, verification: verification ? { met: verification.met, failed: verification.failed } : undefined,
    costUsd: result.usage.costUsd, finishedAt: new Date().toISOString(),
  };
  await setMemory(id, { agentRun: done });
  if (ok || state.attempt > 1) return done;
  // One more attempt: a run that failed goes to the fallback model; a run whose outputs did not verify
  // gets a repair pass on the same model, told exactly what to fix (its files are in the repository now).
  const again = result.state !== "succeeded"
    ? await startAgentRun(id, state.instruction, "system", 2, fallbackModel().id !== state.model ? fallbackModel() : primaryModel())
    : await startAgentRun(id, `${state.instruction}\n\nPOPRAWKA - poprzednia wersja plików jest w repozytorium; popraw ją:\n${(await repairNotes(id, result, verification?.missing || [])).join("\n")}`, "system", 2, MODELS[state.model] || primaryModel());
  return "error" in again ? done : again;
}

/** What to fix, from the failed requirements and placeholders (shown to the agent in a repair pass). */
async function repairNotes(id: string, r: RunResult, missing: string[]): Promise<string[]> {
  const notes: string[] = [];
  if (missing.length) notes.push(`- Brakuje plików (zapisz dokładnie pod tymi nazwami): ${missing.join(", ")}.`);
  if (r.unknownPlaceholders.length) notes.push(`- Użyto znaczników, które nie istnieją: ${r.unknownPlaceholders.join(", ")}. Usuń je (nie podpisuj wiadomości, nie wstawiaj danych, których nie ma).`);
  if (r.alteredPlaceholders.length) notes.push(`- Zmienione znaczniki: ${r.alteredPlaceholders.join(", ")}. Przepisz je dokładnie, z nawiasami.`);
  for (const q of await listRequirements(id)) {
    if (q.status === "failed" && q.id !== "sys-agent-files" && q.id !== "sys-agent-pii" && q.id !== "sys-agent-run") notes.push(`- Niespełnione: ${q.text} (${q.evidence})`);
  }
  return notes;
}

/** File names the instruction asks for (words with a text-file extension), e.g. "kosztorys.csv". */
export function requestedFiles(instruction: string): string[] {
  const out = new Set<string>();
  const seps = " \t\n\r,;:()[]{}\"'`<>!?";
  let word = "";
  const flush = () => {
    let w = word;
    while (w.endsWith(".")) w = w.slice(0, -1);
    const dot = w.lastIndexOf(".");
    const ext = dot > 0 ? w.slice(dot + 1).toLowerCase() : "";
    if (["csv", "txt", "md", "json"].includes(ext) && !w.startsWith(".") && !w.includes("..")) out.add(w);
    word = "";
  };
  for (const ch of instruction) {
    if (seps.includes(ch)) flush();
    else word += ch;
  }
  flush();
  return [...out];
}

function kindOf(path: string): FileKind {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "csv" ? "csv" : ext === "json" ? "json" : ext === "md" ? "md" : "txt";
}

function report(state: AgentRunState, r: RunResult): string {
  return [
    `# Agent run ${r.runId}`,
    `- model: ${state.model} (attempt ${state.attempt})`,
    `- instruction: ${state.instruction}`,
    `- result: ${r.state} (${r.stopReason})${r.error ? ` - ${r.error.slice(0, 300)}` : ""}`,
    `- steps: ${r.usage.steps}, tool calls: ${r.usage.toolCalls} (errors ${r.usage.toolErrors}), cost: $${r.usage.costUsd.toFixed(4)}`,
    `- personal data masked: ${r.piiMasked}; unknown placeholders: ${r.unknownPlaceholders.join(", ") || "none"}; altered: ${r.alteredPlaceholders.join(", ") || "none"}`,
    `- files: ${r.files.map((f) => f.path).join(", ") || "none"}${r.skippedFiles.length ? `; skipped (too large/many): ${r.skippedFiles.join(", ")}` : ""}`,
    "",
    "## Final message",
    r.finalText || "(none)",
    "",
  ].join("\n");
}

// ── Verification (code + Jev) ──

/** Numbers in a text: digit runs, a space between digit groups as a thousands separator, "," or "." decimals. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const chars = [...text, " "];
  let cur = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const isDigit = ch >= "0" && ch <= "9";
    if (isDigit) { cur += ch; continue; }
    const next3 = chars.slice(i + 1, i + 4);
    if (cur && (ch === " " || ch === " " || ch === " ") && next3.length === 3 && next3.every((c) => c >= "0" && c <= "9") && !(chars[i + 4] >= "0" && chars[i + 4] <= "9")) continue;
    if (cur && (ch === "," || ch === ".") && chars[i + 1] >= "0" && chars[i + 1] <= "9" && !cur.includes(".")) { cur += "."; continue; }
    if (cur) { const n = Number(cur); if (Number.isFinite(n)) out.push(n); }
    cur = "";
  }
  return out;
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const t = withoutBom(text);
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ";") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.endsWith("\r") ? cell.slice(0, -1) : cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const num = (s: string | undefined) => {
  const n = numbersIn(s || "");
  return n.length === 1 ? n[0] : null;
};

async function verifyOutputs(id: string, r: RunResult, instruction: string): Promise<{ met: number; failed: number; missing: string[] }> {
  const text = (p: string) => r.files.find((f) => f.path === p && f.encoding === "utf-8")?.content;
  const results: { reqId: string; status: ReqStatus; evidence: string }[] = [];
  const req = async (reqId: string, textReq: string, check: string) => addRequirement(id, { id: reqId, text: textReq, source: "system", check });

  await req("sys-agent-run", "The agent finished the task within its limits (time, steps, cost).", "code");
  results.push({ reqId: "sys-agent-run", status: r.state === "succeeded" ? "met" : "failed", evidence: `${r.state} (${r.stopReason})${r.error ? `: ${r.error.slice(0, 200)}` : ""}` });

  await req("sys-agent-pii", "Personal data was masked for the agent and every placeholder came back unchanged.", "code");
  const piiOk = !r.unknownPlaceholders.length && !r.alteredPlaceholders.length;
  results.push({ reqId: "sys-agent-pii", status: piiOk ? "met" : "failed", evidence: piiOk ? `${r.piiMasked} values masked, all placeholders restored` : `unknown: ${r.unknownPlaceholders.join(", ")}; altered: ${r.alteredPlaceholders.join(", ")}` });

  const wanted = requestedFiles(instruction);
  const missing = wanted.filter((p) => !r.files.some((f) => f.path === p));
  if (wanted.length) {
    await req("sys-agent-files", `The files the task asks for exist: ${wanted.join(", ")}.`, "code");
    results.push({ reqId: "sys-agent-files", status: missing.length ? "failed" : "met", evidence: missing.length ? `missing: ${missing.join(", ")}` : "all present" });
  }

  // Tables with a total row (first cell RAZEM / SUMA / TOTAL...): every number in that row must equal
  // the sum of the numbers above it in its column - for any kind of table the agent produced.
  const totals: number[] = [];
  const TOTAL_LABELS = ["razem", "suma", "łącznie", "lacznie", "total", "sum", "разом", "всього", "итого", "total général"];
  const badTotals: string[] = [];
  let tables = 0;
  for (const f of r.files) {
    if (f.encoding !== "utf-8" || !f.path.toLowerCase().endsWith(".csv")) continue;
    const rows = csvRows(f.content).filter((row) => row.some((c) => c.trim()));
    rows.forEach((row, k) => {
      if (!TOTAL_LABELS.includes(row[0].trim().toLowerCase()) || k === 0) return;
      tables++;
      row.forEach((cell, col) => {
        if (col === 0) return;
        const t = num(cell);
        if (t === null) return;
        totals.push(t);
        let sum = 0;
        for (const above of rows.slice(1, k)) { const v = num(above[col]); if (v !== null) sum += Math.round(v * 100); }
        if (Math.abs(t * 100 - sum) >= 1) badTotals.push(`${f.path} column ${(rows[0][col] || col).toString().trim()}: ${t} != ${sum / 100}`);
      });
    });
  }
  if (tables) {
    await req("sys-agent-totals", "Totals in the produced tables equal the sums of their columns.", "code");
    results.push({ reqId: "sys-agent-totals", status: badTotals.length ? "failed" : "met", evidence: badTotals.join("; ") || `${tables} total row(s) checked` });
  }

  const reply = text("odpowiedz.txt");
  if (reply) {
    const sources = r.files.filter((f) => f.encoding === "utf-8" && f.path !== "odpowiedz.txt").map((f) => f.content);
    const inputs = await inputTexts(id);
    const customer = inputs.request || "";
    // Language: the customer's, checked by Jev.
    await req("sys-agent-language", "The reply is written in the customer's language.", "jev");
    const lang = await customerLanguage(customer);
    if (lang) {
      const a = await jevAsk({ text: reply.slice(0, 3000) }, { l: { type: "noul", instructions: `Is \`text\` written in ${LANGS[lang] || lang}?` } }, 8000);
      const p = (a?.l as any)?.noul as number | undefined;
      results.push({ reqId: "sys-agent-language", status: p === undefined ? "open" : p >= 0.5 ? "met" : "failed", evidence: `customer: ${lang}; P(reply in it) = ${p?.toFixed(2) ?? "n/a"}` });
    } else results.push({ reqId: "sys-agent-language", status: "open", evidence: "customer language unknown" });
    // Scripts: none the customer or the offer data do not use (e.g. Chinese characters in Polish).
    await req("sys-agent-script", "The reply uses no writing system foreign to the customer and the offer.", "code");
    const { strayScripts } = await import("../flows/collect.js");
    const stray = strayScripts(customer + "\n" + inputs.all, reply);
    results.push({ reqId: "sys-agent-script", status: stray.length ? "failed" : "met", evidence: stray.length ? `foreign scripts: ${stray.join(", ")}` : "ok" });
    // Numbers: every number in the reply appears in the project's data or the agent's files.
    await req("sys-agent-numbers", "Every number in the reply comes from the project's data or calculations.", "code");
    const known = new Set<number>();
    for (const t of [...sources, inputs.all]) for (const n of numbersIn(t)) known.add(Math.round(n * 100));
    const unsupported = [...new Set(numbersIn(reply).filter((n) => !known.has(Math.round(n * 100))))];
    results.push({ reqId: "sys-agent-numbers", status: unsupported.length ? "failed" : "met", evidence: unsupported.length ? `not in any file: ${unsupported.join(", ")}` : "ok" });
    if (totals.length) {
      await req("sys-agent-reply-total", "The text for the customer states the total of the produced tables.", "code");
      const has = numbersIn(reply).some((n) => totals.some((t) => Math.abs(n - t) < 0.005));
      results.push({ reqId: "sys-agent-reply-total", status: has ? "met" : "failed", evidence: `totals ${totals.join(", ")} ${has ? "stated" : "not stated"}` });
    }
  }
  return { ...(await recordVerification(id, results, "system", "agent/verification.json")), missing };
}

async function inputTexts(id: string): Promise<{ request: string | null; all: string }> {
  const files = await listFiles(id);
  let all = "";
  let request: string | null = null;
  for (const f of files) {
    if (f.author.startsWith("agent:") || f.size > MAX_INPUT_FILE || !["csv", "txt", "md", "json"].includes(f.kind)) continue;
    const t = await readFile(id, f.path);
    if (t === null) continue;
    if (f.path === "request.txt") request = t;
    all += t + "\n";
  }
  return { request, all };
}

const langMemo = new Map<string, string | null>();
async function customerLanguage(text: string): Promise<string | null> {
  if (!text.trim()) return null;
  const key = text.slice(0, 500);
  if (langMemo.has(key)) return langMemo.get(key)!;
  const a = await jevAsk({ text: text.slice(0, 2000) }, { lang: { type: "choice", instructions: "Which language is `text` written in?", criteria: LANGS } }, 8000);
  const choice = (a?.lang as any)?.choice as string | undefined;
  const lang = choice && choice !== "other" ? choice : null;
  if (langMemo.size > 500) langMemo.clear();
  langMemo.set(key, lang);
  return lang;
}
