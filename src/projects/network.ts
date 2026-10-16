/**
 * Businesses working together inside one project. The customer talks to one business; the agent sees
 * the whole network (same settings.ecosystem): the offers it has as price lists, and a description of
 * every member. When part of the work belongs to another business and the data does not settle it
 * (an unpriced item, a service quoted individually), the agent writes a request for that business
 * (zapytania_do_firm.json, kept with placeholders - no customer personal data leaves the project).
 *
 * Each request becomes a project of that business (business_request@1): its own agent answers from its
 * own offer and site knowledge; its own owner approves or answers questions first if it chose so (or if
 * its agent has questions). The answer comes back into the customer's project (odpowiedzi_firm/), and
 * when every business has answered - or a deadline passes ("no answer": the part stays to be quoted) -
 * the customer's agent finishes the result with the answers. Every step is in both projects' logs.
 */
import { createProject, getProject, setMemory, addEvent, addParticipant } from "./store.js";
import { readFile, writeFile } from "./repo.js";
import { getTenant } from "../multi-tenant/d1-registry.js";

export const REQUESTS_FILE = "zapytania_do_firm.json";
export const ANSWERS_DIR = "odpowiedzi_firm";
export const BUSINESS_REQUEST = "business_request@1";
const MAX_REQUESTS = 6;
const deadlineMs = () => Number(process.env.NETWORK_ANSWER_DEADLINE_MS) || 24 * 3600_000;

export interface NetworkMember { tenantId: string; label: string; about: string }
export interface SubRequest { id: string; tenantId: string; label: string; question: string; status: "waiting" | "answered" | "no_answer"; at: string }

// Passages from a business's own site for a query (registered by the server's TenantManager).
let knowledgeProvider: ((tenantId: string, query: string) => Promise<string[]>) | null = null;
export function setKnowledgeProvider(fn: (tenantId: string, query: string) => Promise<string[]>): void {
  knowledgeProvider = fn;
}

export function businessLabel(tenantId: string): string {
  const t = getTenant(tenantId);
  return t?.settings?.siteCard?.brand || t?.brandName || t?.domain || tenantId;
}

/** The network the business belongs to (itself included), with what each member does. */
export async function networkMembers(tenantId: string): Promise<NetworkMember[]> {
  const self = getTenant(tenantId);
  const eco = typeof self?.settings?.ecosystem === "string" ? self.settings.ecosystem.trim() : "";
  const { listTenants } = await import("../multi-tenant/d1-registry.js");
  const all = eco ? listTenants().filter((t) => t.settings?.ecosystem === eco && t.status === "active") : self ? [self] : [];
  return all.slice(0, 40).map((t) => {
    const card = t.settings?.siteCard || {};
    const sections = Array.isArray(card.sections) ? card.sections.map((s: any) => `${s.label}: ${String(s.text || "").split("\n").join(" ")}`).join(" | ") : "";
    return { tenantId: t.id, label: businessLabel(t.id), about: [card.tagline, card.eyebrow, sections].filter(Boolean).join(" - ").slice(0, 700) };
  });
}

interface RawRequest { firma?: string; pytanie?: string }

/**
 * After a run of the customer's project: the requests to other businesses it wrote (first round only).
 * Returns true when requests went out (the result waits for the answers).
 */
export async function askBusinesses(parentId: string, slugs: Record<string, string>): Promise<boolean> {
  const parent = await getProject(parentId);
  if (!parent || parent.memory.networkAsked) return false;
  let raw: RawRequest[] = [];
  try { raw = JSON.parse((await readFile(parentId, REQUESTS_FILE)) || "[]"); } catch { raw = []; }
  if (!Array.isArray(raw)) raw = [];
  const byTenant = new Map<string, string[]>();
  for (const r of raw.slice(0, MAX_REQUESTS * 3)) {
    const tenantId = slugs[String(r?.firma || "").trim()];
    const q = String(r?.pytanie || "").trim();
    if (!tenantId || tenantId === parent.initiatorTenantId || q.length < 5) continue;
    byTenant.set(tenantId, [...(byTenant.get(tenantId) || []), q.slice(0, 2000)]);
  }
  // Only parts the customer asked for (the agent tends to add extras: materials nobody mentioned, etc.).
  if (byTenant.size) {
    const { jevAsk } = await import("../llm/jev.js");
    const conversation = ((await readFile(parentId, "rozmowa.md").catch(() => null)) || (await readFile(parentId, "request.txt").catch(() => null)) || "").slice(-3000);
    const entries = [...byTenant.entries()].flatMap(([t, qs]) => qs.map((q) => ({ t, q })));
    const qs: Record<string, { type: "noul"; instructions: string }> = {};
    entries.forEach((e, k) => { qs[`r${k}`] = { type: "noul", instructions: `A request to another business: "${e.q.slice(0, 600)}". Did the customer, in \`conversation\`, ask for the specific product, service or part this request is about? Only if the customer brought it up - an addition the customer never mentioned does not count.` }; });
    const a = await jevAsk({ conversation }, qs, 10_000);
    if (a) {
      byTenant.clear();
      entries.forEach((e, k) => { if ((((a as any)[`r${k}`]?.noul as number) ?? 1) >= 0.5) byTenant.set(e.t, [...(byTenant.get(e.t) || []), e.q]); });
      const dropped = entries.length - [...byTenant.values()].flat().length;
      if (dropped) await addEvent(parentId, { kind: "business_requests_dropped", actor: "system", data: { dropped } });
    }
  }
  if (!byTenant.size) return false;
  const from = businessLabel(parent.initiatorTenantId);
  const subs: SubRequest[] = [];
  for (const [tenantId, qs] of [...byTenant].slice(0, MAX_REQUESTS)) {
    const question = qs.join("\n");
    const sub = await createProject(BUSINESS_REQUEST, { customerSession: `project:${parentId}`, initiatorTenantId: tenantId, title: `Zapytanie od ${from}`.slice(0, 120), memory: { parentId, fromTenant: parent.initiatorTenantId }, ttlHours: 30 * 24 });
    await addParticipant(sub.id, parent.initiatorTenantId, "initiator").catch(() => {});
    await addParticipant(parentId, tenantId, "quoting").catch(() => {});
    const request = `Firma ${from} (z tej samej sieci firm) przygotowuje dla swojego klienta wycenę / projekt i pyta Twoją firmę:\n\n${question}\n`;
    await writeFile(sub.id, "request.txt", request, "txt", `business:${parent.initiatorTenantId}`);
    await writeFile(sub.id, "rozmowa.md", `# Zapytanie od ${from}\n\n**${from}:** ${question}\n`, "md", "system");
    const knowledge = knowledgeProvider ? await knowledgeProvider(tenantId, question).catch(() => []) : [];
    if (knowledge.length) await writeFile(sub.id, "wiedza/strona.md", `# Informacje z witryny firmy\n\n${knowledge.join("\n\n---\n\n")}\n`, "md", "system");
    await setMemory(sub.id, { baseInstruction: SUB_INSTRUCTION });
    const { planAndRun } = await import("./plan.js");
    const started = await planAndRun(sub.id, SUB_INSTRUCTION, `business:${parent.initiatorTenantId}`);
    subs.push({ id: sub.id, tenantId, label: businessLabel(tenantId), question, status: "waiting", at: new Date().toISOString() });
    await addEvent(parentId, { kind: "business_asked", actor: "agent", data: { to: tenantId, project: sub.id, question: question.slice(0, 1000), started: !("error" in started) } });
    if ("error" in started) await settle(sub.id, "", "no_answer");
  }
  await setMemory(parentId, { networkAsked: true, subRequests: subs });
  return true;
}

export const SUB_INSTRUCTION = `Inna firma z Twojej sieci (opis w request.txt) przygotowuje projekt dla swojego klienta i pyta o część,
która należy do Twojej firmy. Odpowiedz na podstawie danych Twojej firmy: oferta w cenniki/ (jeśli jest) i informacje
z witryny w wiedza/. Odpowiedź dla firmy pytającej zapisz w odpowiedz.txt - konkretnie: ceny i warunki z danych;
czego nie ma w danych, napisz wprost, że wymaga indywidualnej wyceny. Nie wymyślaj cen ani terminów.`;

/** A business's answer (or its absence) goes back into the customer's project. */
export async function settle(subId: string, answer: string, status: "answered" | "no_answer"): Promise<void> {
  const sub = await getProject(subId);
  const parentId = sub?.memory.parentId as string | undefined;
  if (!sub || !parentId || sub.memory.settled) return;
  await setMemory(subId, { settled: status });
  const parent = await getProject(parentId);
  if (!parent) return;
  const subs = ((parent.memory.subRequests as SubRequest[]) || []).map((s) => (s.id === subId ? { ...s, status } : s));
  const s = subs.find((x) => x.id === subId);
  const text = status === "answered" && answer.trim()
    ? answer.trim()
    : "(firma nie odpowiedziała w wyznaczonym czasie - tę część trzeba oznaczyć jako do wyceny)";
  await writeFile(parentId, `${ANSWERS_DIR}/${slugOf(s?.label || sub.initiatorTenantId)}.md`, `# Odpowiedź firmy ${s?.label || sub.initiatorTenantId}\n\n## Pytanie\n\n${s?.question || ""}\n\n## Odpowiedź\n\n${text}\n`, "md", `business:${sub.initiatorTenantId}`);
  await setMemory(parentId, { subRequests: subs });
  await addEvent(parentId, { kind: "business_answered", actor: sub.initiatorTenantId, data: { project: subId, status, answer: text.slice(0, 2000) } });
  if (subs.every((x) => x.status !== "waiting")) await continueParent(parentId);
}

/** Every business answered (or timed out): the customer's agent finishes the result with the answers. */
async function continueParent(parentId: string): Promise<void> {
  const p = await getProject(parentId);
  if (!p || p.memory.networkContinued) return;
  await setMemory(parentId, { networkContinued: true, agentPending: Date.now() });
  const base = String(p.memory.baseInstruction || "");
  const { planAndRun } = await import("./plan.js");
  const r = await planAndRun(parentId, base, "system", `Firmy z sieci odpowiedziały na zapytania - odpowiedzi są w ${ANSWERS_DIR}/ (dodaj je do danych wejściowych). Wynik dla klienta ma je uwzględnić: ceny i warunki podane przez firmy traktować jak dane z cennika (z nazwą firmy); części bez odpowiedzi lub bez ceny - do wyceny. Bez nowych zapytań do firm (bez pliku ${REQUESTS_FILE}).`);
  if ("error" in r) console.warn(`[network] ${parentId}: could not continue: ${r.error}`);
}

/** Businesses that did not answer in time count as "no answer" (checked when the customer's chat polls). */
export async function checkDeadlines(parentId: string): Promise<boolean> {
  const p = await getProject(parentId);
  const subs = (p?.memory.subRequests as SubRequest[] | undefined) || [];
  const waiting = subs.filter((s) => s.status === "waiting");
  if (!waiting.length) return false;
  for (const s of waiting) if (Date.now() - Date.parse(s.at) > deadlineMs()) await settle(s.id, "", "no_answer");
  return true;
}

export function waitingOnBusinesses(memory: Record<string, unknown>): boolean {
  return ((memory.subRequests as SubRequest[] | undefined) || []).some((s) => s.status === "waiting");
}

function slugOf(label: string): string {
  const map: Record<string, string> = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };
  let out = "";
  for (const ch of label.toLowerCase()) {
    const c = map[ch] ?? ch;
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) out += c;
    else if (out && !out.endsWith("_")) out += "_";
  }
  while (out.endsWith("_")) out = out.slice(0, -1);
  return out.slice(0, 40) || "firma";
}
