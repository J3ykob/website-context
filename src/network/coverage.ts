/**
 * Which parts of a customer's request the business itself has - ONE decision that every network path
 * follows (the owner's rule, 2026-11-04: the network only for what the business itself does not have).
 *
 * Before, each path guessed on its own: one whole-message Jev "ours" < 0.35 (relay at once) and < 0.8 (offer
 * the network), "every item ours?" (the calculation), "our items cover every part?" (the order form), and a
 * broadcast that kept a request with the business only when it priced EVERY part. The iteration-4 judges
 * (evals/judged/next-plan.md §3) found the business's own products sent to the background calculation or to
 * competitors in 6 conversations: Bosta Beton asked to quote Łazy's own B20 (betonlazy-1), Pełny Parkiet
 * priced inside DJMW's own quote (djmw-2), Bosta's own HydroBeton offered to the network at "ours" 0.79
 * (bostabeton-3).
 *
 * The parts are the request's stored split (src/projects/broadcast.ts splitNeed), read with the business's one-line
 * description (its site card: whom the customer writes to). Then, side by side - one Jev call for 0, the checks of
 * every part in parallel:
 *   0. which parts the customer wants to get (not a mere mention), and which part only goes with another part's
 *      product - its delivery, transport, assembly, installation or pumping, or an accessory (the add-on index;
 *      asked here, not in the split, whose prompt made up such parts when it was asked there);
 *   1. its own items: every pick of the item matcher (the same call the network makes for every candidate - its
 *      order is not best first), confirmed by Jev as the thing itself (src/network/find.ts sameThing);
 *   2. its own 6 nearest passages, its description first, judged by the order form's question about the kind of
 *      product or service, whatever the amount, with the customer's own words (src/flows/collect.ts offeredOdds:
 *      "offered" or "several" >= 0.5 counts, "unknown" does not).
 * A part is the business's when an item of its own is confirmed, when its pages say so, or when it is an add-on of
 * one of its parts (see decide). What could not be judged - the split, the matcher, Jev, the embedding or the page
 * search failed, or the decision was not ready within the caller's time limit - is the business's: fail closed, a
 * false "not ours" sends its customer to a competitor.
 */
import type { OfferItem } from "../offer/store.js";
import { turnUsage } from "../llm/turn-usage.js";

export type CoverageHow = "item" | "page" | "addon" | "unjudged" | "none";
export interface Coverage {
  parts: string[];
  own: boolean[];         // the business has this part itself
  priced: boolean[];      // ... and a confirmed item of it has a price
  items: OfferItem[][];   // its confirmed items per part
  passages: string[][];   // its own passages per part, when the pages decided
  how: CoverageHow[];     // what decided it ("none" = not the business's)
  late?: boolean;         // not decided within the caller's time limit: every part counts as the business's
}

// Every pick of the matcher goes to the same-thing question (offerMatches gives at most 15, two per name): it lists
// them in offer order, not best first - djmw-2's "DJ na wesele w Warszawie" (3500-5500 zł) came 4th-9th of 11 and was
// never judged with the first 3, while an FAQ hourly rate priced the part (2026-11-04 smoke).
const SAME_MAX = 15;
const PASSAGES = 6;          // own passages for the page question: as many as the order form's check judged (offeredForForm topK 6, replaced by this)
const MEMO_MS = 10 * 60_000; // one decision per request: the chat's routing, its reply and the project ask about it within minutes
const RETRY_MS = 30_000;     // a decision with a failed step is not kept for 10 minutes
// How long a caller waits for the decision (the chat's order form, calculation and choice of action; the reply waits
// less - chat.ts COVERAGE_WAIT_MS): usually 1.2-4.4 s; one matcher timeout (8 s, retried) took 11 s and cold offer
// vectors 19.6-23.2 s (romax-3, 1,239 items - 2026-11-04 smokes). Late: every part the business's, this caller only - the
// decision goes on and later callers get it.
const MAX_MS = () => Number(process.env.COVERAGE_MAX_MS) || 8000;
// The pages' answer counts at this (Jev: offered / not_offered): see 3. in decide.
const PAGES_MIN = 0.5;
const ASKED_MIN = 0.5;   // Jev: the customer wants to get the part (step 0)
const ADDON_MIN = 0.5;   // Jev: the part only goes with that other part's product (step 0)

// A price of its own or in its components (rental rates, per-guest tiers): either prices the part.
const hasPrice = (i: OfferItem) => i.price_value != null || i.components.some((c) => c.price_value != null);
const none = (): Coverage => ({ parts: [], own: [], priced: [], items: [], passages: [], how: [] });
// Every part the business's, unjudged (a failed step, or late for the caller).
const allOwn = (parts: string[], late = false): Coverage => ({
  parts, own: parts.map(() => true), priced: parts.map(() => false), items: parts.map(() => []), passages: parts.map(() => []),
  how: parts.map(() => "unjudged" as const), ...(late ? { late: true } : {}),
});
interface Entry { at: number; ttl: number; p: Promise<Coverage>; parts?: string[] }
const memo = new Map<string, Entry>();

/**
 * The coverage of a need for one business; `items`: its offer when the caller has it loaded; `maxMs`: how long this
 * caller waits (default COVERAGE_MAX_MS). Never throws.
 */
export function coverage(tenantId: string, need: string, opts: { items?: OfferItem[]; maxMs?: number } = {}): Promise<Coverage> {
  const norm = need.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 3000);
  const key = `${tenantId}\n${opts.items ? opts.items.length : "*"}\n${norm}`;
  let hit = memo.get(key);
  if (!hit || Date.now() - hit.at > hit.ttl) {
    const entry: Entry = { at: Date.now(), ttl: MEMO_MS, p: Promise.resolve(none()) };
    entry.p = decide(tenantId, need, opts.items, (parts) => { entry.parts = parts; })
      .catch((e) => { console.warn(`[coverage] ${tenantId}: ${(e as Error).message}`); return allOwn(entry.parts || []); })
      .then((c) => { if (!c.parts.length || c.how.includes("unjudged")) entry.ttl = RETRY_MS; return c; });
    if (memo.size > 2000) memo.clear();
    memo.set(key, (hit = entry));
  }
  const entry = hit;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Coverage>((r) => { timer = setTimeout(() => r(allOwn(entry.parts || [], true)), opts.maxMs ?? MAX_MS()); });
  return Promise.race([entry.p, late]).then((c) => {
    clearTimeout(timer);
    if (c.late) console.log(`[coverage] ${tenantId}: not decided within ${opts.maxMs ?? MAX_MS()} ms - every part counts as its own this time`);
    note(need, c);
    return c;
  });
}

async function decide(tenantId: string, need: string, given: OfferItem[] | undefined, onParts: (parts: string[]) => void): Promise<Coverage> {
  const t0 = Date.now();
  const { splitNeed } = await import("../projects/broadcast.js");
  // The split's model could not be asked: the whole request is one part, the business's (fail closed - one part judged
  // instead would put the own products of a mixed request in front of competitors).
  const splitAll = await splitNeed(need, tenantId).catch(() => null);
  if (!splitAll) return allOwn([need.replace(/\s+/g, " ").trim().slice(0, 300)]);
  if (!splitAll.length) return none(); // asks for no product or service
  onParts(splitAll);
  const { businessLine } = await import("../projects/network.js");
  const about = businessLine(tenantId);
  // 0. One Jev call next to the checks below (no added wait):
  // - wanted: a part the customer only mentions or already has is dropped - "wchodzimy na salę o 17" became a hall to
  //   find for a DJ's customer, "new floors with underfloor heating" an installer for a screed maker's, and such a part
  //   routes the request to the background calculation and the network. Whom the customer writes to settles it: the
  //   hall 0.42 -> 0.06 with the DJ's description, the heating 0.67 -> 0.41, the parts asked for 0.80-0.95 either way
  //   (2026-11-04 probes; the split with the description makes such parts much less often, see broadcast.ts).
  // - the add-on index: a part that only goes with another part's product (Łazy's delivery and pump for its own
  //   concrete, a florist's sash and delivery for its wreath) is the business's when that part is (below).
  // Jev unavailable (6 s): every part stays, and with several parts none can come out not ours (3. below).
  const { jevAsk } = await import("../llm/jev.js");
  const qs: Record<string, any> = {};
  splitAll.forEach((p, k) => {
    qs[`w${k}`] = { type: "noul", instructions: `${about ? "The customer writes to the business described in `business`. " : ""}Does the customer, in \`customer_message\`, want to get "${p.slice(0, 300)}" - buy, rent or have it done (also when only asking whether the business has or does it) - rather than only mentioning it or already having it?` };
    if (splitAll.length > 1) qs[`o${k}`] = { type: "choice", instructions: `Is \`parts[${k}]\` only something that goes with the product or service of another of \`parts\` - its delivery, transport, assembly, installation or pumping, or an accessory for it? If so, which one?`,
      criteria: Object.fromEntries([["none", "No - it is a product or service of its own."], ...splitAll.map((q, j) => [`part_${j}`, q.slice(0, 200)] as const).filter((_, j) => j !== k)]) };
  });
  const askedP = jevAsk({ ...(about ? { business: about } : {}), customer_message: need.slice(0, 3000), parts: splitAll }, qs, 6000).catch(() => null);
  const items = given ?? ((await (await import("../offer/store.js")).loadOffer(tenantId).catch(() => null))?.items || []);
  const { offerMatches } = await import("../projects/network.js");
  const { sameThing } = await import("./find.js");
  const { BGEEmbeddingProvider } = await import("../embeddings/bge-provider.js");
  const { CloudflareVectorizeStore } = await import("../embeddings/vectorize-store.js");
  const { siteText } = await import("../llm/packs.js");
  const { offeredOdds } = await import("../flows/collect.js");
  const vecsP = new BGEEmbeddingProvider({ model: "bge-m3" }).embed(splitAll).catch(() => null);
  const store = new CloudflareVectorizeStore({ tenantId });
  const judgedAll = await Promise.all(splitAll.map(async (part, k) => {
    // 1. Its own items confirmed as the thing itself; null = could not be judged (the matcher or Jev failed) - not
    // "no item" (a matcher outage made Bosta's own HydroBeton and Łazy's own B20 "not ours" - 2026-11-04 smoke).
    const itemsP = (async (): Promise<OfferItem[] | null> => {
      if (!items.length) return [];
      const picks = await offerMatches(tenantId, items, part).catch(() => null);
      if (!picks) return null;
      if (!picks.length) return [];
      const all = picks.slice(0, SAME_MAX);
      const same = await sameThing(part, all).catch(() => null);
      return same ? all.filter((_, j) => same[j]) : null;
    })();
    // 2. Its own pages (keyword lines stripped, as the reply sees them). No passages at all is an answer (nothing shows
    // it, no call needed); a failed embedding, search or Jev is not (null).
    const pageP = (async () => {
      const vec = (await vecsP)?.[k];
      const hits = vec ? await store.search(vec, PASSAGES).catch(() => null) : null;
      const passages = hits ? hits.map((h) => siteText(h.content)).filter(Boolean) : null;
      const odds = !passages ? null : !passages.length ? {} : await offeredOdds(part, about ? [`O firmie: ${about}`, ...passages] : passages, need).catch(() => null);
      return { passages: passages || [], odds };
    })();
    const [confirmed, page] = await Promise.all([itemsP, pageP]);
    return { confirmed, page };
  }));
  // The parts the customer wants (the add-on index mapped onto them; a pointer to a dropped part is null).
  const asked = (await askedP) as Record<string, any> | null;
  const kept = splitAll.map((_, k) => k).filter((k) => !asked || ((asked[`w${k}`]?.noul as number) ?? 1) >= ASKED_MIN);
  const notAsked = splitAll.filter((_, k) => !kept.includes(k));
  if (notAsked.length) console.log(`[coverage] ${tenantId}: not asked for - ${notAsked.map((p) => `"${p.slice(0, 60)}"`).join(", ")}`);
  if (!kept.length) return none();
  const at = new Map(kept.map((k, j) => [k, j]));
  const parts = kept.map((k) => splitAll[k]);
  const of = kept.map((k) => {
    const o = asked?.[`o${k}`] as { choice?: string; probabilities?: Record<string, number> } | undefined;
    const b = o?.choice?.startsWith("part_") && (o.probabilities?.[o.choice] ?? 0) >= ADDON_MIN ? Number(o.choice.slice(5)) : null;
    return b != null && b !== k && at.has(b) ? at.get(b)! : null;
  });
  const judged = kept.map((k) => judgedAll[k]);

  // 3. The decision per part. Ours: a priced confirmed item (the business's own price list); an unpriced one its pages do
  // not deny; or its pages say offered. One rule for the pages - their answer when it has at least PAGES_MIN: a bare
  // unpriced name ("Instalacje solarne") was confirmed for photovoltaics at a solar-thermal installer, whose pages say
  // not_offered 0.77-0.90 to the question of the kind with the customer's words, while the business's own parts are at
  // 0.00-0.04 (Bosta's HydroBeton 0.00-0.04, where "not_offered >= 0.35" on the old question denied it - 0.44-0.53;
  // probe 2026-11-04). "Several" (several of its offers could be what the customer means) is offered too, one of them -
  // the florist's delivery: offered 0.31-0.45 + several 0.17-0.36; every part not the business's in the smokes had several
  // <= 0.01. Not ours only when every check could be asked: what could not be judged is ours - also every part that is
  // not ours by its own checks when step 0 failed for several parts (it may be an add-on of one of ours).
  const offered = (o: Record<string, number>) => (o.offered ?? 0) + (o.several ?? 0) >= PAGES_MIN && (o.not_offered ?? 0) < PAGES_MIN;
  const denied = (o: Record<string, number>) => (o.not_offered ?? 0) >= PAGES_MIN;
  const byItems = judged.map(({ confirmed, page }) => (confirmed?.length && (confirmed.some(hasPrice) || !(page.odds && denied(page.odds))) ? confirmed : []));
  // Step 0 not answered for a part of several (the call failed, or Jev left out its key): whether it goes with another is unknown.
  const addonUnknown = (k: number) => splitAll.length > 1 && !(asked?.[`o${kept[k]}`] as { choice?: string } | undefined)?.choice;
  const how: CoverageHow[] = judged.map(({ confirmed, page }, k) => {
    if (byItems[k].length) return "item";
    if (page.odds && offered(page.odds)) return "page";
    return confirmed === null || page.odds === null || addonUnknown(k) ? "unjudged" : "none";
  });
  const own = how.map((h) => h !== "none");
  // An add-on goes with its part (a chain - the pump of the concrete for the delivered concrete - takes one round per link).
  for (let round = 0; round < parts.length; round++) {
    let changed = false;
    parts.forEach((_, k) => { const b = of[k]; if (!own[k] && b != null && b !== k && own[b]) { own[k] = true; how[k] = "addon"; changed = true; } });
    if (!changed) break;
  }
  const c: Coverage = {
    parts, own, how,
    priced: parts.map((_, k) => own[k] && byItems[k].some(hasPrice)),
    items: byItems,
    passages: judged.map((j) => j.page.passages),
  };
  console.log(`[coverage] ${tenantId}: ${parts.map((p, k) => `${own[k] ? "own" : "foreign"}:${how[k]}${c.priced[k] ? "$" : ""}${of[k] != null ? `(+${of[k]! + 1})` : ""} "${p.slice(0, 60)}"`).join(", ")} (${Date.now() - t0} ms)`);
  (await import("../llm/decision-log.js")).logDecision("coverage", "matcher+jev", { need: need.slice(0, 3000), about, parts, of }, { own, priced: c.priced, how, items: byItems.map((l) => l.map((i) => i.name.slice(0, 80))), notAsked }, tenantId);
  return c;
}

// The turn's trace for the evals: every coverage the turn used, by need (late = not decided in time for the caller).
type Noted = { need: string; parts: string[]; late?: boolean };
function note(need: string, c: Coverage): void {
  const u = turnUsage.getStore();
  if (!u) return;
  const debug = (u.debug ||= {});
  const list = (debug.coverage ||= []) as Noted[];
  if (!list.some((x) => x.need === need.slice(0, 300))) list.push({ need: need.slice(0, 300), parts: c.parts.map((p, k) => `${c.own[k] ? "own" : "foreign"}:${c.how[k]}${c.priced[k] ? "$" : ""} ${p}`), ...(c.late ? { late: true } : {}) });
}
