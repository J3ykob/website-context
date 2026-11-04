/**
 * The network's offers for a customer's request (the customer's project): the request split into parts
 * (neutral wording, no personal data - only the parts leave the project), and per part who offers it. The
 * parts the business running the project has itself are its own, with its confirmed items
 * (src/network/coverage.ts); only the other parts go to the network's one search (src/network/find.ts, the
 * same one the chat uses), that business excluded. Matched items with prices are precise offers; the rest
 * are "does this, price to agree" and get asked. Arithmetic is not trusted here - the agent recomputes.
 */
import type { OfferItem } from "../offer/store.js";

const MODEL = () => process.env.NETWORK_MODEL || "deepseek/deepseek-v4.1-flash";
const PICKS = 3;   // offers picked per part
const MAX_PARTS = 8;
// The project's own coverage (when the chat gave none): a cold offer's vectors took 19.6-23.2 s (romax-3, 2026-11-04);
// a hung page search has no timeout of its own. Late = every part the business's (src/network/coverage.ts).
const BROADCAST_COVERAGE_MS = 60_000;

export interface NetworkOffer { tenantId: string; part: number; precise: boolean; text: string; items: OfferItem[] }
/** own[k]: part k is the business's own (coverage) - its picks are that business alone. */
export interface Broadcast { parts: string[]; own: boolean[]; answered: number; declined: number; picked: NetworkOffer[]; ms: number }

/** One JSON answer of the network's model (the split, a hand-off's request); null when it could not be asked. */
export async function llmJson(system: string, user: string, maxTokens = 1200): Promise<any> {
  for (let k = 0; k < 2; k++) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL(), temperature: 0, max_tokens: maxTokens, response_format: { type: "json_object" }, provider: (await import("../llm/pin.js")).routingFor(MODEL()).provider, seed: 7, reasoning: { enabled: false },
          messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
      const j = (await r.json()) as any;
      return JSON.parse(j?.choices?.[0]?.message?.content || "");
    } catch { /* one retry */ }
  }
  return null;
}

// "po polsku" alone left a Ukrainian request Ukrainian ("Оренда віброплити...") - and the businesses' offers are Polish
// (2026-11-04: 9 messages in 6 languages, all Polish with the sentence on other languages).
// What the customer says a thing is for stays in its part: "panele słoneczne - chodzi mi o prąd" lost the "prąd" that tells
// photovoltaics from Insanit's solar thermal (insanit-1, 2026-11-04 smoke).
// Whom the customer writes to (the business's one-line description, the user message's first line) settles what is asked
// (2026-11-04, deepseek-v4.1-flash pinned, probe draws + smoke runs of this wording): a DJ's customer's "wchodzimy na salę
// o 17 i chcemy żeby grało do 5 rano" was a hall to find, or "organizacja wesela", in 3 of 7 splits without it - one DJ
// part in 5 of 5 with it; "new floors with underfloor heating" no more an installer at a screed maker (0 of 5). "od tej
// firmy albo od innej": without it a photographer's "robicie też dj-a? a jak nie, polecicie kogoś?" got no parts in 1 of 5
// (in 11 of 11 with the description elsewhere in the prompt), with it 0 of 5. The add-on index ("of": a part's delivery,
// assembly, pumping...) is no longer asked here: its sentence and example list added parts nobody asked for (a heating
// installer 4-6 of 6, a pump for "z dowozem" 5-6 of 6, 0 of 6 without it) - src/network/coverage.ts asks Jev instead.
const SPLIT = `Rozpisujesz prośbę klienta do firmy na części, o które sieć firm ma złożyć oferty. Zwróć JSON {"parts": ["..."]}:
jedna część = jeden produkt lub usługa, z ilościami, wymiarami, czasem i tym, co klient mówi o jego rodzaju lub
przeznaczeniu (przelicz oczywiste: wymiary -> powierzchnia lub objętość, dni tygodnia -> liczba dób). Części piszesz
zawsze po polsku, także gdy klient pisze w innym języku: produkty i usługi nazywasz tak, jak nazywają je polskie firmy
w swoich ofertach. Bez danych osobowych klienta (imię, nazwisko, telefon, e-mail, dokładny adres - zostaw najwyżej
miejscowość lub dzielnicę).
Tylko to, co klient chce dostać - kupić, wynająć albo zlecić - od tej firmy albo od innej (także gdy pyta, czy firma to
ma lub robi). Gdy wiadomość nie prosi o żaden produkt ani usługę: {"parts": []}.`;

const normNeed = (need: string) => need.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 3000);

/**
 * The request as parts the network can quote (neutral, without personal data). tenantId: the business the customer
 * writes to - its one-line description frames the reading. Rejects when the model could not be asked (nothing is
 * stored, the next call asks again), so a failure is never read as "asks for nothing".
 */
export async function splitNeed(need: string, tenantId?: string): Promise<string[]> {
  const about = tenantId ? (await import("./network.js")).businessLine(tenantId) : "";
  // The chat's page search, its item matcher, the coverage and the network search ask for the same split at the same
  // moment: one model call.
  const k = `${about}\n${normNeed(need)}`;
  let p = splitInFlight.get(k);
  if (!p) { p = splitOnce(need, about).finally(() => splitInFlight.delete(k)); splitInFlight.set(k, p); }
  return p;
}
const splitInFlight = new Map<string, Promise<string[]>>();

async function splitOnce(need: string, about: string): Promise<string[]> {
  // Stored per business description + normalised request: hosted models are not repeatable even at temperature 0 with a
  // fixed provider and seed (measured 2026-10-30: 2 different splits in 4 calls), so the same request is split once and
  // the split reused - every later step sees the same parts.
  const { createHash } = await import("crypto");
  // v5: the business's description, no "of" (2026-11-04); v4: "what the customer wants to get"; v3: "of"; v2: Polish.
  const key = `decisions/split/${createHash("sha1").update(`v5\n${about}\n${normNeed(need)}`).digest("hex")}.json`;
  const hit = splitMemo.get(key);
  if (hit) return hit;
  const { downloadFromR2, uploadToR2 } = await import("../storage/r2.js");
  const stored = await downloadFromR2(key).then((b) => (b ? JSON.parse(b.toString("utf-8")) : null)).catch(() => null);
  if (Array.isArray(stored?.parts) && stored.parts.length) { splitMemo.set(key, stored.parts); return stored.parts; }
  const j = await llmJson(SPLIT, about ? `Klient pisze do firmy: ${about}\n\n${need.slice(0, 3000)}` : need.slice(0, 3000), 800);
  if (!j) throw new Error("the split model could not be asked");
  const parts = (Array.isArray(j?.parts) ? j.parts : []).filter((p: unknown): p is string => typeof p === "string" && p.trim().length > 2).map((p: string) => p.trim().slice(0, 300)).slice(0, MAX_PARTS);
  (await import("../llm/decision-log.js")).logDecision("split", MODEL(), { need: need.slice(0, 3000), about }, parts);
  // "Asks for nothing" is not kept as the decision: one draw left a real request without parts (above), and kept it
  // would decide that request for good.
  if (!parts.length) return parts;
  if (splitMemo.size > 5000) splitMemo.clear();
  splitMemo.set(key, parts);
  await uploadToR2(key, JSON.stringify({ parts }), "application/json").catch(() => {});
  return parts;
}
const splitMemo = new Map<string, string[]>();

/**
 * The chat's coverage of the request (src/network/coverage.ts), as agentTurn keeps it in the project's memory:
 * the parts, which are the business's own, and its confirmed items for each part as offer item ids.
 */
export interface GivenCoverage { parts: string[]; own: boolean[]; items?: string[][] }

const usable = (g: GivenCoverage | null | undefined): g is GivenCoverage =>
  !!g && Array.isArray(g.parts) && g.parts.length > 0 && Array.isArray(g.own) && g.own.length === g.parts.length;

/**
 * The whole round. tenantIds: the network (only for its name); ownFirst: the business running the project.
 * Its own parts (src/network/coverage.ts - `given`, the chat's decision when the chat started the run, so both
 * decide the same; otherwise decided here on the project's need) are picked for it alone, with its confirmed
 * items; the network is searched for the other parts only, that business excluded. Until 2026-11-04 it competed
 * for every part and kept a request to itself only when its price list priced every part: its own unpriced
 * products were asked of competitors (betonlazy-1: Bosta asked to quote Łazy's own B20), and rule 6 could pick
 * a competitor over its priced item. Never throws: a failure means no network offers.
 */
export async function broadcastNeed(need: string, tenantIds: string[], ownFirst?: string, given?: GivenCoverage | null): Promise<Broadcast> {
  const t0 = Date.now();
  const host = ownFirst || tenantIds[0];
  const none = (): Broadcast => ({ parts: [], own: [], answered: 0, declined: 0, picked: [], ms: Date.now() - t0 });
  const { getTenant } = await import("../multi-tenant/d1-registry.js");
  const eco = getTenant(host)?.settings?.ecosystem;
  if (typeof eco !== "string" || !eco) return none();
  const { loadOffer, renderItem } = await import("../offer/store.js");
  const offer = (await loadOffer(host).catch(() => null))?.items || [];
  let parts: string[], own: boolean[], items: OfferItem[][];
  if (given) {
    // The chat's decision, also when it has no parts (the request named nothing, or it was not decided in time): no
    // network then - the project does what the chat's turn decided.
    if (!usable(given)) return none();
    // Its confirmed items by id, from its offer as it is now (an item removed since is gone).
    const byId = new Map(offer.map((i) => [i.id, i]));
    ({ parts, own } = given);
    items = parts.map((_, k) => (own[k] ? (given.items?.[k] || []).map((id) => byId.get(id)).filter((i): i is OfferItem => !!i) : []));
  } else {
    // In the background nobody waits on the first word: the decision may take longer than in the chat (BROADCAST_COVERAGE_MS).
    const { coverage } = await import("../network/coverage.js");
    const c = await coverage(host, need, { items: offer, maxMs: BROADCAST_COVERAGE_MS }).catch(() => null);
    if (!c?.parts.length) return none();
    ({ parts, own, items } = c);
  }
  const foreign = parts.map((_, k) => k).filter((k) => !own[k]);
  const { findBusinesses } = await import("../network/find.js");
  const r = foreign.length ? await findBusinesses(need, eco, { exclude: host, parts: foreign.map((k) => parts[k]) }).catch(() => null) : null;
  // The search's part j is the request's part foreign[j].
  const hits = (r?.hits || []).map((h) => ({ ...h, part: foreign[h.part] }));
  const { businessLabel } = await import("./network.js");
  const label = businessLabel(host);
  const hasPrice = (i: OfferItem) => i.price_value != null || i.components.some((c) => c.price_value != null);
  const picked: NetworkOffer[] = parts.flatMap((_, k): NetworkOffer[] => own[k]
    ? [{ tenantId: host, part: k, precise: items[k].some(hasPrice), items: items[k],
        text: `${label}: ${items[k].length ? items[k].slice(0, 4).map((it) => renderItem(it).slice(0, 300)).join("\n") : "(według jej strony, cena do ustalenia)"}` }]
    : hits.filter((h) => h.part === k).slice(0, PICKS).map((h) => ({ tenantId: h.tenantId, part: k, precise: h.precise, text: `${h.label}: ${h.text}`, items: h.items })));
  const answered = new Set(hits.map((h) => h.tenantId)).size;
  return { parts, own, answered, declined: Math.max(0, (r?.asked || 0) - answered), picked, ms: Date.now() - t0 };
}
