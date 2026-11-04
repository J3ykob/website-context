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

export interface NetworkOffer { tenantId: string; part: number; precise: boolean; text: string; items: OfferItem[] }
/** own[k]: part k is the business's own (coverage) - its picks are that business alone. */
export interface Broadcast { parts: string[]; own: boolean[]; answered: number; declined: number; picked: NetworkOffer[]; ms: number }
/** The request as parts; of[k] = the part whose product part k only goes with (its delivery, assembly...), else null. */
export interface Split { parts: string[]; of: (number | null)[] }

async function llmJson(system: string, user: string, maxTokens = 1200): Promise<any> {
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
// "of" (2026-11-04): a part that only goes with another part's product is the same business's when the product is
// (src/network/coverage.ts) - Łazy's delivery and pump for its own concrete, a florist's sash and delivery for its wreath.
// Agent rule 9 said it only as prompt text, and the chat had no way to know it.
// What the customer says a thing is for stays in its part, and what they only mention is no part (2026-11-04 smoke of the
// coverage): "panele słoneczne - chodzi mi o prąd" lost the "prąd" that tells photovoltaics from Insanit's solar thermal
// (insanit-1); "wchodzimy na salę o 17" became a wedding hall to find for a DJ's customer (djmw-2) in 3 of 3 splits with
// "only what they ask for, not what they only mention", 0 of 3 with "what they want to get - buy, rent or have done";
// "robicie też dj-a?" (asking whether the business does it) is a request too - one wording returned no parts for it.
const SPLIT = `Rozpisujesz prośbę klienta na części, o które sieć firm ma złożyć oferty. Zwróć JSON {"parts": ["..."], "of": [...]}:
jedna część = jeden produkt lub usługa, z ilościami, wymiarami, czasem i tym, co klient mówi o jego rodzaju lub
przeznaczeniu (przelicz oczywiste: wymiary -> powierzchnia lub objętość, dni tygodnia -> liczba dób). Części piszesz
zawsze po polsku, także gdy klient pisze w innym języku: produkty i usługi nazywasz tak, jak nazywają je polskie firmy
w swoich ofertach. Bez danych osobowych klienta (imię, nazwisko, telefon, e-mail, dokładny adres - zostaw najwyżej
miejscowość lub dzielnicę).
Tylko to, co klient chce dostać - kupić, wynająć albo zlecić (także gdy pyta, czy firma to ma lub robi); nie to, co już
ma albo tylko wspomina (np. salę, w której będzie impreza, dom, w którym trwa remont).
Gdy wiadomość nie prosi o żaden produkt ani usługę: {"parts": [], "of": []}.
"of" - dla każdej części numer (od 0) części, z której produktem ta część tylko idzie (jego dowóz, montaż, instalacja,
transport, pompowanie, akcesorium), inaczej null.`;

/** The request as parts the network can quote (neutral, without personal data). */
export async function splitNeed(need: string): Promise<string[]> {
  return (await splitParts(need)).parts;
}

/** The parts with the add-on index (see Split). */
export async function splitParts(need: string): Promise<Split> {
  // The chat's page search, its item matcher and the coverage ask for the same split at the same moment: one model call.
  const k = need.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 3000);
  let p = splitInFlight.get(k);
  if (!p) { p = splitOnce(need).finally(() => splitInFlight.delete(k)); splitInFlight.set(k, p); }
  return p;
}
const splitInFlight = new Map<string, Promise<Split>>();

async function splitOnce(need: string): Promise<Split> {
  // Stored per normalised request: hosted models are not repeatable even at temperature 0 with a fixed
  // provider and seed (measured 2026-10-30: 2 different splits in 4 calls), so the same request is split
  // once and the split reused - every later step sees the same parts.
  const norm = need.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 3000);
  const { createHash } = await import("crypto");
  // v4: what the customer only mentions is no part (2026-11-04, after the coverage smoke - a v3 split stored before that
  // wording is not reused); v3: "of"; v2: parts always in Polish.
  const key = `decisions/split/${createHash("sha1").update(`v4\n${norm}`).digest("hex")}.json`;
  const hit = splitMemo.get(key);
  if (hit) return hit;
  const { downloadFromR2, uploadToR2 } = await import("../storage/r2.js");
  const stored = await downloadFromR2(key).then((b) => (b ? JSON.parse(b.toString("utf-8")) : null)).catch(() => null);
  if (Array.isArray(stored?.parts) && Array.isArray(stored?.of) && stored.of.length === stored.parts.length) { splitMemo.set(key, stored); return stored; }
  const j = await llmJson(SPLIT, need.slice(0, 3000), 800);
  if (!j) return { parts: [], of: [] }; // the model failed: nothing stored, the next call tries again
  const raw: unknown[] = Array.isArray(j?.parts) ? j.parts : [];
  const rawOf: unknown[] = Array.isArray(j?.of) ? j.of : [];
  // The parts kept (and their indices in the model's list): "of" points into the model's list, so it is mapped
  // onto the kept parts; a pointer to a dropped part, to itself or out of range is null.
  const kept: number[] = [];
  raw.forEach((p, i) => { if (typeof p === "string" && p.trim().length > 2 && kept.length < MAX_PARTS) kept.push(i); });
  const at = new Map(kept.map((i, k) => [i, k]));
  const split: Split = {
    parts: kept.map((i) => (raw[i] as string).trim().slice(0, 300)),
    of: kept.map((i, k) => { const t = rawOf[i]; const m = typeof t === "number" && Number.isInteger(t) ? at.get(t) : undefined; return m !== undefined && m !== k ? m : null; }),
  };
  if (splitMemo.size > 5000) splitMemo.clear();
  splitMemo.set(key, split);
  (await import("../llm/decision-log.js")).logDecision("split", MODEL(), { need: need.slice(0, 3000) }, split);
  await uploadToR2(key, JSON.stringify(split), "application/json").catch(() => {});
  return split;
}
const splitMemo = new Map<string, Split>();

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
  if (usable(given)) {
    // Its confirmed items by id, from its offer as it is now (an item removed since is gone).
    const byId = new Map(offer.map((i) => [i.id, i]));
    ({ parts, own } = given);
    items = parts.map((_, k) => (own[k] ? (given.items?.[k] || []).map((id) => byId.get(id)).filter((i): i is OfferItem => !!i) : []));
  } else {
    const { coverage } = await import("../network/coverage.js");
    const c = await coverage(host, need, { items: offer }).catch(() => null);
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
