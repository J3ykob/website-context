/**
 * Businesses working together inside one project. The customer talks to one business; the need goes out
 * to the whole network (same settings.ecosystem) and every member checks it against its own offer
 * (advertise): only businesses that have something for it come into the project, each with the items it
 * matched (or its description, when it has no item list). When part of the work belongs to another business and the data does not settle it
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
import type { OfferItem } from "../offer/store.js";

export const REQUESTS_FILE = "zapytania_do_firm.json";
export const ANSWERS_DIR = "odpowiedzi_firm";
export const BUSINESS_REQUEST = "business_request@1";
const MAX_REQUESTS = 6;
const deadlineMs = () => Number(process.env.NETWORK_ANSWER_DEADLINE_MS) || 24 * 3600_000;

export interface NetworkMember { tenantId: string; label: string; about: string }
export interface SubRequest { id: string; tenantId: string; label: string; question: string; status: "waiting" | "answered" | "no_answer"; at: string; ownerAsked?: boolean }

// Passages from a business's own site for a query (registered by the server's TenantManager).
let knowledgeProvider: ((tenantId: string, query: string) => Promise<string[]>) | null = null;
export function setKnowledgeProvider(fn: (tenantId: string, query: string) => Promise<string[]>): void {
  knowledgeProvider = fn;
}

/**
 * A business that has not joined: it is in the network from its public data (site, offer) and nobody runs
 * it. Its requests are answered from that data straight away - no owner to wait for - marked as not
 * confirmed, and the business is then invited to confirm, correct, or join (src/projects/invite.ts).
 * NETWORK_LISTED_FORCE / NETWORK_MEMBER_FORCE: tenant ids treated as listed / as members (live tests only).
 */
export function isListed(tenantId: string): boolean {
  if ((process.env.NETWORK_LISTED_FORCE || "").split(",").includes(tenantId)) return true;
  if ((process.env.NETWORK_MEMBER_FORCE || "").split(",").includes(tenantId)) return false;
  return getTenant(tenantId)?.settings?.network === "listed";
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

/** A business that has something for the need: the items it matched (none = by its description only). */
export interface Advert { tenantId: string; items: OfferItem[]; byDescription: boolean; unjudged?: boolean }

const ADVERT_ITEMS = 15;
const NEAREST = 30; // candidates per business by meaning
const JUDGE_BATCH = 15;
export const MUST_ASK_MAX = 4; // businesses one customer request must ask (agent.ts) - the agent asks at most these

/**
 * The items of one business's offer that a need is about: the nearest by meaning (any language), judged
 * by Jev as a short list. [] = nothing of it; null = could not be judged (Jev down).
 */
export async function offerMatches(tenantId: string, items: OfferItem[], need: string): Promise<OfferItem[] | null> {
  if (!items.length) return [];
  const { matchOfferItems } = await import("../offer/search.js");
  const { nearestItems } = await import("../offer/vectors.js");
  if (items.length <= NEAREST) return matchOfferItems(need, items, ADVERT_ITEMS, 0.4);
  const near = (await nearestItems(tenantId, items, need, NEAREST)) ?? items.slice(0, NEAREST * 2);
  // A need with several parts: the nearest by meaning go to the main one, so items sharing a word with
  // the need are added too (5-letter stems, so Polish inflection matches: "gruntu" ~ "grunt").
  const { words } = await import("../offer/search.js");
  // A shared word counts by how rare it is in this offer ("grunt" in one item beats "podłoga" in fifty).
  const stems = new Set(words(need).map((w) => w.slice(0, 5)));
  const itemStems = items.map((i) => new Set(words(i.name).map((w) => w.slice(0, 5))));
  const df = new Map<string, number>();
  for (const set of itemStems) for (const st of set) if (stems.has(st)) df.set(st, (df.get(st) || 0) + 1);
  const lexical = items.map((i, k) => ({ i, n: [...itemStems[k]].reduce((sum, st) => sum + (df.has(st) ? 1 / df.get(st)! : 0), 0) }))
    .filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 10).map((x) => x.i);
  // Jev judges short lists reliably and long ones poorly: batches of 15, all at once.
  const pool = [...new Set([...near, ...lexical])];
  const batches: OfferItem[][] = [];
  for (let k = 0; k < pool.length; k += JUDGE_BATCH) batches.push(pool.slice(k, k + JUDGE_BATCH));
  const judged = await Promise.all(batches.map((b) => matchOfferItems(need, b, b.length, 0.4)));
  if (judged.some((x) => x === null)) return null;
  const matched = judged.flatMap((x) => x!);
  // The same product in many sizes would fill the list: at most two of one name.
  const seen = new Map<string, number>();
  return matched.filter((i) => { const key = i.name.toLowerCase().slice(0, 40); const n = (seen.get(key) || 0) + 1; seen.set(key, n); return n <= 2; }).slice(0, ADVERT_ITEMS);
}

/**
 * The need goes out to the network; each business decides on its own data whether it can help. Businesses
 * with an item list take the items nearest to the need by meaning (item vectors, cached per offer) and Jev
 * judges those (one call each, all at once); every member's
 * description is judged in one more call (services that have no item list, or not all of them listed).
 * A business whose items could not be judged (Jev down) is kept with its whole offer - never dropped silently.
 */
export async function advertise(need: string, tenantIds: string[]): Promise<Advert[]> {
  const { loadOffer } = await import("../offer/store.js");
  const { jevAsk } = await import("../llm/jev.js");
  const members = new Map((await networkMembers(tenantIds[0]).catch(() => [])).map((m) => [m.tenantId, m]));
  const described = tenantIds.filter((id) => members.get(id)?.about);
  const [matched, byAbout] = await Promise.all([
    Promise.all(tenantIds.map(async (id) => {
      const items = (await loadOffer(id).catch(() => null))?.items || [];
      const m = await offerMatches(id, items, need);
      return m === null ? { items, unjudged: true } : { items: m, unjudged: false };
    })),
    described.length
      ? jevAsk({ need: need.slice(0, 3000), businesses: described.map((id) => `${members.get(id)!.label}: ${members.get(id)!.about}`) },
        Object.fromEntries(described.map((_, k) => [`b${k}`, { type: "noul" as const, instructions: `Does the business \`businesses[${k}]\` offer a product or service that \`need\` asks for (any part of it, in any language)? Only what it offers itself, not something merely related.` }])), 10_000)
      : Promise.resolve(null),
  ]);
  const aboutYes = new Set(described.filter((_, k) => (((byAbout as any)?.[`b${k}`]?.noul as number) ?? 0) >= 0.5));
  return tenantIds.flatMap((id, k): Advert[] => {
    const r = matched[k];
    if (r.items.length) return [{ tenantId: id, items: r.items, byDescription: false, ...(r.unjudged ? { unjudged: true } : {}) }];
    return aboutYes.has(id) ? [{ tenantId: id, items: [], byDescription: true }] : [];
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
  const subs: SubRequest[] = [];
  for (const [tenantId, qs] of [...byTenant].slice(0, MAX_REQUESTS)) {
    const sub = await askOne(parentId, tenantId, qs.join("\n"));
    if (sub) subs.push(sub);
  }
  await setMemory(parentId, { networkAsked: true, subRequests: subs });
  return true;
}

/** One request to one business: its own project (business_request@1), answered under its own settings. */
export async function askOne(parentId: string, tenantId: string, question: string): Promise<SubRequest | null> {
  const parent = await getProject(parentId);
  if (!parent) return null;
  const from = businessLabel(parent.initiatorTenantId);
  const listed = isListed(tenantId);
  const sub = await createProject(BUSINESS_REQUEST, { customerSession: `project:${parentId}`, initiatorTenantId: tenantId, title: `Zapytanie od ${from}`.slice(0, 120), memory: { parentId, fromTenant: parent.initiatorTenantId, ...(listed ? { listed: true } : {}) }, ttlHours: 30 * 24 });
  await addParticipant(sub.id, parent.initiatorTenantId, "initiator").catch(() => {});
  await addParticipant(parentId, tenantId, "quoting").catch(() => {});
  const request = `Firma ${from} (z tej samej sieci firm) przygotowuje dla swojego klienta wycenę / projekt i pyta Twoją firmę:\n\n${question}\n`;
  await writeFile(sub.id, "request.txt", request, "txt", `business:${parent.initiatorTenantId}`);
  await writeFile(sub.id, "rozmowa.md", `# Zapytanie od ${from}\n\n**${from}:** ${question}\n`, "md", "system");
  const knowledge = knowledgeProvider ? await knowledgeProvider(tenantId, question).catch(() => []) : [];
  if (knowledge.length) await writeFile(sub.id, "wiedza/strona.md", `# Informacje z witryny firmy\n\n${knowledge.join("\n\n---\n\n")}\n`, "md", "system");
  const instruction = listed ? `${SUB_INSTRUCTION}\n${LISTED_NOTE}` : SUB_INSTRUCTION;
  await setMemory(sub.id, { baseInstruction: instruction, question: question.slice(0, 2000) });
  const { planAndRun } = await import("./plan.js");
  const started = await planAndRun(sub.id, instruction, `business:${parent.initiatorTenantId}`);
  await addEvent(parentId, { kind: "business_asked", actor: "agent", data: { to: tenantId, project: sub.id, question: question.slice(0, 1000), started: !("error" in started) } });
  if ("error" in started) await settle(sub.id, "", "no_answer");
  return { id: sub.id, tenantId, label: businessLabel(tenantId), question, status: "waiting", at: new Date().toISOString() };
}

export const SUB_INSTRUCTION = `Inna firma z Twojej sieci (opis w request.txt) przygotowuje projekt dla swojego klienta i pyta o część,
która należy do Twojej firmy. Odpowiedz na podstawie danych Twojej firmy: oferta w cenniki/ (jeśli jest) i informacje
z witryny w wiedza/. Odpowiedź dla firmy pytającej zapisz w odpowiedz.txt - konkretnie: ceny i warunki z danych;
czego nie ma w danych, napisz wprost, że wymaga indywidualnej wyceny. Nie wymyślaj cen ani terminów.`;

// A business that has not joined: nobody from it answers - its public data does, and says so.
export const LISTED_NOTE = `Ta firma nie dołączyła jeszcze do sieci: nikt z firmy nie odpowiada - odpowiedź przygotowujesz
wyłącznie z jej publicznych danych (oferta, strona). Pisz o firmie w trzeciej osobie ("w cenniku firmy ... "), nie obiecuj
niczego w jej imieniu (terminów, dostępności, rabatów) i zaznacz, że ceny pochodzą z publicznych danych firmy i nie zostały
przez nią potwierdzone. Nie zapisuj pytań do firmy - nie ma komu odpowiedzieć.`;
const LISTED_HEADER = "(Firma nie dołączyła do sieci - odpowiedź przygotowana z jej publicznych danych; ceny niepotwierdzone przez firmę.)";

/** A business's answer (or its absence) goes back into the customer's project. */
export async function settle(subId: string, answer: string, status: "answered" | "no_answer"): Promise<void> {
  const sub = await getProject(subId);
  const parentId = sub?.memory.parentId as string | undefined;
  if (!sub || !parentId) return;
  // A listed business confirming or correcting after the customer got its part: recorded in the
  // customer's project for the business running it (who can pass it on).
  if (sub.memory.settled) {
    if (sub.memory.listed && status === "answered" && answer.trim()) await lateConfirmation(sub.id, parentId, sub.initiatorTenantId, answer.trim());
    // The owner's own price for what its assistant left unpriced: a new offer for the customer.
    else if (sub.memory.ownerQuote === "asked" && status === "answered" && answer.trim()) {
      await setMemory(subId, { ownerQuote: "answered" });
      await addEvent(parentId, { kind: "business_confirmed", actor: sub.initiatorTenantId, data: { project: subId, answer: answer.trim().slice(0, 2000), ownerQuote: true } });
      await deliverBusinessOffer(parentId, sub.initiatorTenantId, answer.trim());
    }
    await syncParent(parentId); // repairs a parent that still lists it as waiting (see syncParent)
    return;
  }
  await setMemory(subId, { settled: status });
  const parent = await getProject(parentId);
  if (!parent) return;
  const s = ((parent.memory.subRequests as SubRequest[]) || []).find((x) => x.id === subId);
  const text = status === "answered" && answer.trim()
    ? `${sub.memory.listed ? `${LISTED_HEADER}\n\n` : ""}${answer.trim()}`
    : "(firma nie odpowiedziała w wyznaczonym czasie - tę część trzeba oznaczyć jako do wyceny)";
  await writeFile(parentId, `${ANSWERS_DIR}/${slugOf(s?.label || sub.initiatorTenantId)}.md`, `# Odpowiedź firmy ${s?.label || sub.initiatorTenantId}\n\n## Pytanie\n\n${s?.question || ""}\n\n## Odpowiedź\n\n${text}\n`, "md", `business:${sub.initiatorTenantId}`);
  await addEvent(parentId, { kind: "business_answered", actor: sub.initiatorTenantId, data: { project: subId, status, answer: text.slice(0, 2000), ...(sub.memory.listed ? { listed: true } : {}) } });
  await syncParent(parentId);
  // The customer's result does not wait for it; the business hears about the request afterwards.
  if (sub.memory.listed && status === "answered") {
    const { inviteListed } = await import("./invite.js");
    void inviteListed(subId).catch((e) => console.warn(`[invite] ${subId}: ${(e as Error).message}`));
  }
}

async function lateConfirmation(subId: string, parentId: string, tenantId: string, answer: string): Promise<void> {
  const label = businessLabel(tenantId);
  await writeFile(parentId, `${ANSWERS_DIR}/${slugOf(label)}-potwierdzenie.md`, `# ${label} - potwierdzenie po wysłaniu wyniku klientowi\n\n${answer}\n`, "md", `business:${tenantId}`);
  await addEvent(parentId, { kind: "business_confirmed", actor: tenantId, data: { project: subId, answer: answer.slice(0, 2000) } });
  await setMemory(subId, { confirmedAt: new Date().toISOString() });
}

/** Every business answered (or timed out): the customer's agent finishes the result with the answers. */
/**
 * The parent's list of sub-requests, rebuilt from each sub-request's own "settled" mark (the source of
 * truth). Two businesses settling at once each wrote back the list they had read, and the second write
 * lost the first's answer: the request then waited on a business that had answered - forever, since
 * the deadline check skips settled sub-requests. Rebuilt from the marks, the last write is always complete.
 */
async function syncParent(parentId: string): Promise<void> {
  const parent = await getProject(parentId);
  if (!parent) return;
  const subs = await Promise.all(((parent.memory.subRequests as SubRequest[]) || []).map(async (x) => {
    const settled = (await getProject(x.id).catch(() => null))?.memory.settled as SubRequest["status"] | undefined;
    return settled && settled !== x.status ? { ...x, status: settled } : x;
  }));
  await setMemory(parentId, { subRequests: subs });
  if (subs.every((x) => x.status !== "waiting")) await continueParent(parentId);
}

async function continueParent(parentId: string): Promise<void> {
  const p = await getProject(parentId);
  if (!p || p.memory.networkContinued) return;
  await setMemory(parentId, { networkContinued: true, agentPending: Date.now() });
  const base = String(p.memory.baseInstruction || "");
  // Businesses that have not joined: their parts come from public data, and the customer is told so.
  const listed = ((p.memory.subRequests as SubRequest[]) || []).filter((x) => x.status === "answered" && isListed(x.tenantId)).map((x) => x.label);
  // Businesses whose owner was asked for the price its assistant could not give.
  const owners = ((p.memory.subRequests as SubRequest[]) || []).filter((x) => x.ownerAsked && !isListed(x.tenantId)).map((x) => x.label);
  const { planAndRun } = await import("./plan.js");
  const r = await planAndRun(parentId, base, "system", `Firmy z sieci odpowiedziały na zapytania - odpowiedzi są w ${ANSWERS_DIR}/ (dodaj je do danych wejściowych). Wynik dla klienta ma je uwzględnić: ceny i warunki podane przez firmy traktować jak dane z cennika (z nazwą firmy); części bez odpowiedzi lub bez ceny - do wyceny. Gdy część prac nie ma ceny, nie podawaj kwoty ani widełek dla całości - tylko ceny pozycji, które je mają, i wprost, że reszta czeka na wyceny. Nie podstawiaj innych produktów lub usług zamiast tych, o które pytał klient.${listed.length ? ` Odpowiedzi firm ${listed.join(", ")} przygotowano z ich publicznych danych, a same firmy poprosiliśmy o wycenę: z tych odpowiedzi weź tylko ceny, które firma faktycznie publikuje (przy nich napisz, że to cena z publicznego cennika firmy, niepotwierdzona przez nią), a nie opisuj, czego w jej danych brakuje. Napisz klientowi wprost, że poprosiliśmy firmy ${listed.join(", ")} o wycenę i że ich oferty pojawią się na stronie statusu zapytania, a klient dostanie powiadomienie, gdy przyjdą (odpowiedzi innych firm są od firm).` : ""}${owners.length ? ` Firmy ${owners.join(", ")} nie podały w odpowiedzi ceny części prac: poprosiliśmy ich właścicieli o wycenę. Napisz klientowi wprost, że ich ceny pojawią się na stronie statusu zapytania, a klient dostanie powiadomienie, gdy przyjdą.` : ""} Bez nowych zapytań do firm (bez pliku ${REQUESTS_FILE}).`);
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

/**
 * Does a business's answer leave part of what was asked without a price ("needs an individual quote",
 * "no price in our data")? Then its owner is asked for one (askOwnerForQuote) - the customer's result
 * says the rest waits for quotes, and someone has to give them.
 */
export async function leavesUnpriced(question: string, answer: string): Promise<boolean> {
  const { jevAsk } = await import("../llm/jev.js");
  const a = await jevAsk({ request: question.slice(0, 3000), answer: answer.slice(0, 6000) }, {
    unpriced: { type: "noul", instructions: "`request` asks a business for prices or a quote, and `answer` is that business's reply. Does `answer` leave any priced part of `request` without a concrete price or amount (says it needs an individual quote, is to be agreed, or isn't in the price list)?" },
  }, 8000).catch(() => null);
  return (((a as any)?.unpriced?.noul as number) ?? 0) >= 0.5;
}

/**
 * The owner of a business that has joined is asked for the price its assistant left out: the review
 * page (with the request and the assistant's answer) by email. The customer's result does not wait;
 * the owner's reply reaches the customer as a new offer (settle -> deliverBusinessOffer).
 */
export async function askOwnerForQuote(subId: string, runId: string, answer: string): Promise<void> {
  const sub = await getProject(subId);
  const parentId = sub?.memory.parentId as string | undefined;
  if (!sub || !parentId) return;
  const { openReview, reviewForRun } = await import("./review.js");
  const rv = (await reviewForRun(subId, runId)) || (await openReview(subId, sub.initiatorTenantId, runId, answer, [], false));
  await setMemory(subId, { ownerQuote: "asked" });
  const parent = await getProject(parentId);
  if (parent) await setMemory(parentId, { subRequests: ((parent.memory.subRequests as SubRequest[]) || []).map((x) => (x.id === subId ? { ...x, ownerAsked: true } : x)) });
  const t = getTenant(sub.initiatorTenantId);
  let base = (process.env.BASE_URL || "").trim();
  if (!base.startsWith("http")) base = "https://whisp.so";
  while (base.endsWith("/")) base = base.slice(0, -1);
  const { sendOwnerQuoteEmail } = await import("../multi-tenant/email.js");
  const emailed = t?.email ? await sendOwnerQuoteEmail(t.email, {
    from: businessLabel(String(sub.memory.fromTenant || "")), request: String(sub.memory.question || "").slice(0, 1500), answer: answer.slice(0, 2000), link: `${base}/review/${rv.token}`,
  }).catch(() => false) : false;
  await addEvent(subId, { kind: "owner_quote_asked", actor: "system", data: { emailed } });
  await addEvent(parentId, { kind: "owner_quote_asked", actor: "system", data: { business: sub.initiatorTenantId, project: subId, emailed } });
}

/**
 * A business's own offer after the customer's result: on the customer's status page, in their chat log,
 * and by the channels the customer chose (SMS / WhatsApp / Telegram, e-mail).
 */
export async function deliverBusinessOffer(parentId: string, tenantId: string, offer: string): Promise<void> {
  const parent = await getProject(parentId);
  if (!parent) return;
  const offers = [...((parent.memory.businessOffers as any[]) || []), { tenantId, label: businessLabel(tenantId), text: offer.slice(0, 4000), at: new Date().toISOString() }];
  await setMemory(parentId, { businessOffers: offers });
  const { logMessage } = await import("../storage/conversation-store.js");
  await logMessage(parent.initiatorTenantId, parent.customerSession, "assistant", `Oferta od firmy ${businessLabel(tenantId)}:\n\n${offer.slice(0, 4000)}`, { flowInvoked: "network-offer" }).catch(() => {});
  const { customerLink } = await import("./conversation.js");
  let base = (process.env.BASE_URL || "").trim();
  if (!base.startsWith("http")) base = "https://whisp.so";
  while (base.endsWith("/")) base = base.slice(0, -1);
  const link = `${base}/p/${await customerLink(parentId)}`;
  const t = getTenant(parent.initiatorTenantId);
  const brand = t?.settings?.siteCard?.brand || t?.brandName || t?.domain || "";
  // SMS / WhatsApp / Telegram if the customer chose them: a short "new offer" with their status page.
  const ch = parent.memory.customerContact as import("./notify-channels.js").CustomerContact | undefined;
  if (ch && (ch.phone || ch.whatsapp || ch.telegramChatId)) {
    const { sendNewOffer } = await import("./notify-channels.js");
    const sent = await sendNewOffer(ch, { brand, business: businessLabel(tenantId), link }).catch((e) => ({ error: String((e as Error).message).slice(0, 200) }));
    await addEvent(parentId, { kind: "offer_messaged", actor: "system", data: { business: tenantId, ...sent } }).catch(() => {});
  }
  // The customer asked for the result by email: the offer goes there too, with their page (all answers).
  if (ch?.email) {
    try {
      const { sendCustomerOfferEmail } = await import("../multi-tenant/email.js");
      const sent = await sendCustomerOfferEmail(ch.email, { lang: ch.lang || "pl", brand, business: businessLabel(tenantId), offer: offer.slice(0, 4000), link, replyTo: t?.email || "" });
      await addEvent(parentId, { kind: "offer_emailed", actor: "system", data: { business: tenantId, sent } });
    } catch (e) { await addEvent(parentId, { kind: "offer_emailed", actor: "system", data: { business: tenantId, sent: false, error: String((e as Error).message).slice(0, 200) } }).catch(() => {}); }
  }
}
