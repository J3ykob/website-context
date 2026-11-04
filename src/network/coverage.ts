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
 * Per part of the request's stored split (src/projects/broadcast.ts splitParts) that the customer wants to get (Jev,
 * next to the checks below - the split also makes parts of what the customer only mentions), side by side:
 *   1. its own items: the item matcher's picks (the same call the network makes for every candidate), the
 *      first 3 confirmed by Jev as the thing itself - not a component, a related job or a substitute
 *      (src/network/find.ts sameThing);
 *   2. its own 6 nearest passages, judged by the order form's strict question (src/flows/collect.ts
 *      offeredHere: "offered" >= 0.5 counts, "unknown" does not) - with its one-line description first (its
 *      site card: what kind of business it is), so a venue's "Obsługa (np. foto; kamera...) - 120 zł" per
 *      vendor is not read as its own photographer (offered 0.72 without it, 0.30 with it; a florist's own
 *      delivery 0.83 / 0.85 - 2026-11-04 smoke). They settle a part no item confirms (or a business without
 *      an item list), and outweigh a confirmation that rests on unpriced item names alone when they lean to
 *      "not offered" (not_offered >= DENY_MIN), and such pages never make a part ours: Insanit's bare
 *      "Instalacje solarne" was confirmed for photovoltaics, while its pages list solar thermal collectors
 *      (not_offered 0.41-0.92, offered 0.27-0.52 - "more not_offered than offered" missed it 4 times in 8 on the
 *      same passages); the business's own parts: not_offered 0-0.25 with unpriced items, 0-0.04 by pages alone
 *      (2026-11-04 smokes);
 *   3. a part that only goes with another part's product (its delivery, assembly, pumping, an accessory -
 *      the split's add-on index) is the business's when that part is;
 *   4. what could not be judged at all (matcher, Jev or the page search unavailable) is the business's:
 *      fail closed - a false "not ours" sends its customer to a competitor, and in the chat a Jev outage
 *      means no router and so no network anyway.
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
}

const PICKS = 3;             // matcher picks confirmed per part: find.ts judges the first 3 priced items per business the same way
const PASSAGES = 6;          // own passages for the page question: as many as the order form's check judged (offeredForForm topK 6, replaced by this)
const MEMO_MS = 10 * 60_000; // one decision per request: the chat's routing, its reply and the project ask about it within minutes
const RETRY_MS = 30_000;     // a split or a judgement that failed is not kept as the decision for 10 minutes
// The split's own call may wait 2 x 60 s (broadcast.ts llmJson); the chat's order form and calculation wait for the
// coverage, so a hung split counts as failed after this (usually 0.5-1.5 s; it is still stored when it comes).
const SPLIT_WAIT_MS = 10_000;
// Pages that lean to "not offered" (not_offered at least this) overrule a confirmation by unpriced items and never make a
// part ours: see 2. above (the business's own parts 0-0.25, photovoltaics at a solar-thermal installer 0.41-0.92).
const DENY_MIN = 0.35;
// A part of the split is one the customer wants to get (Jev noul): see 0. in decide().
const ASKED_MIN = 0.5;

// A price of its own or in its components (rental rates, per-guest tiers): either prices the part.
const hasPrice = (i: OfferItem) => i.price_value != null || i.components.some((c) => c.price_value != null);
const none = (): Coverage => ({ parts: [], own: [], priced: [], items: [], passages: [], how: [] });
const memo = new Map<string, { at: number; ttl: number; p: Promise<Coverage> }>();

/** The coverage of a need for one business; `items`: its offer when the caller has it loaded. Never throws. */
export function coverage(tenantId: string, need: string, opts: { items?: OfferItem[] } = {}): Promise<Coverage> {
  const key = `${tenantId}\n${need.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 3000)}`;
  let hit = memo.get(key);
  if (!hit || Date.now() - hit.at > hit.ttl) {
    const entry = { at: Date.now(), ttl: MEMO_MS, p: Promise.resolve(none()) };
    entry.p = decide(tenantId, need, opts.items).catch((e) => { console.warn(`[coverage] ${tenantId}: ${(e as Error).message}`); return none(); })
      .then((c) => { if (!c.parts.length || c.how.includes("unjudged")) entry.ttl = RETRY_MS; return c; });
    if (memo.size > 2000) memo.clear();
    memo.set(key, (hit = entry));
  }
  return hit.p.then((c) => { note(need, c); return c; });
}

async function decide(tenantId: string, need: string, given?: OfferItem[]): Promise<Coverage> {
  const t0 = Date.now();
  const { splitParts } = await import("../projects/broadcast.js");
  // A failed or hung split: no parts - nothing goes to the network and every path treats the request as the business's
  // own (fail closed). The whole message as one part instead would put the business's own products of a mixed request
  // in front of competitors.
  const split = await Promise.race([splitParts(need).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), SPLIT_WAIT_MS))]);
  const { parts: splitAll, of: ofAll } = split || { parts: [] as string[], of: [] as (number | null)[] };
  if (!splitAll.length) return none();
  // The business's one-line description (its site card: what kind of business it is) frames both questions to Jev.
  const card = (await import("../multi-tenant/d1-registry.js")).getTenant(tenantId)?.settings?.siteCard || {};
  const about = [card.eyebrow, card.tagline].filter((x: unknown) => typeof x === "string" && x.trim()).join(" - ");
  // 0. Only what the customer wants to get (Jev, one call next to the checks below - no added wait): the split also makes
  // parts of things the customer only mentions or already has, against its own rule - "wchodzimy na salę o 17" became a
  // hall to find for a DJ's customer in 3 of 7 splits, "new floors with underfloor heating" an installer for a screed
  // maker's (2026-11-04 smokes) - and such a part routes the request to the background calculation and the network.
  // Whom the customer writes to settles it: the hall 0.42 -> 0.06 with the DJ's description, the heating 0.67 -> 0.41,
  // the parts asked for 0.80-0.95 either way. Jev unavailable: every part stays.
  const { jevAsk } = await import("../llm/jev.js");
  const askedP = jevAsk({ ...(about ? { business: about } : {}), customer_message: need.slice(0, 3000) }, Object.fromEntries(splitAll.map((p, k) => [`p${k}`, { type: "noul" as const, instructions: `${about ? "The customer writes to the business described in \`business\`. " : ""}Does the customer, in \`customer_message\`, want to get "${p.slice(0, 300)}" - buy, rent or have it done (also when only asking whether the business has or does it) - rather than only mentioning it or already having it?` }])), 6000).catch(() => null);
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
    // 1. Its own items: the matcher's picks, the first few confirmed as the thing itself.
    const itemsP = (async () => {
      const picks = items.length ? await offerMatches(tenantId, items, part).catch(() => null) : [];
      if (!picks?.length) return [] as OfferItem[];
      const top = picks.slice(0, PICKS);
      const same = await sameThing(part, top).catch(() => null);
      return same ? top.filter((_, j) => same[j]) : [];
    })();
    // 2. Its own pages (keyword lines stripped, as the reply sees them). No passages at all is an answer (nothing shows
    // it, no call needed); a failed search or Jev is not (null).
    const pageP = (async () => {
      const vec = (await vecsP)?.[k];
      const hits = vec ? await store.search(vec, PASSAGES).catch(() => null) : null;
      const passages = hits ? hits.map((h) => siteText(h.content)).filter(Boolean) : null;
      const odds = !passages ? null : !passages.length ? {} : await offeredOdds(part, about ? [`O firmie: ${about}`, ...passages] : passages).catch(() => null);
      return { passages: passages || [], odds };
    })();
    const [confirmed, page] = await Promise.all([itemsP, pageP]);
    return { confirmed, page };
  }));
  // The parts the customer wants (the add-on index mapped onto them; a pointer to a dropped part is null).
  const asked = await askedP;
  const kept = splitAll.map((_, k) => k).filter((k) => !asked || ((((asked as any)[`p${k}`]?.noul as number) ?? 1) >= ASKED_MIN));
  const notAsked = splitAll.filter((_, k) => !kept.includes(k));
  if (notAsked.length) console.log(`[coverage] ${tenantId}: not asked for - ${notAsked.map((p) => `"${p.slice(0, 60)}"`).join(", ")}`);
  if (!kept.length) return none();
  const at = new Map(kept.map((k, j) => [k, j]));
  const parts = kept.map((k) => splitAll[k]);
  const of = kept.map((k) => { const b = ofAll[k]; return b != null && at.has(b) ? at.get(b)! : null; });
  const judged = kept.map((k) => judgedAll[k]);

  // 3. The decision per part: a priced confirmed item, or one the pages do not deny; else the pages; what could not be
  // asked at all (null) is the business's.
  const offered = (o: Record<string, number>) => (o.offered ?? 0) >= 0.5;
  const denied = (o: Record<string, number>) => (o.not_offered ?? 0) >= DENY_MIN;
  const byItems = judged.map(({ confirmed, page }) => (confirmed.some(hasPrice) || (confirmed.length && !(page.odds && denied(page.odds))) ? confirmed : []));
  const how: CoverageHow[] = judged.map(({ confirmed, page }, k) => {
    if (byItems[k].length) return "item";
    // Pages that lean to "not offered" never make a part ours either (the same cut as for unpriced items): Insanit's
    // photovoltaics came out offered 0.52 with not_offered 0.41-0.42 in 2 of 4 samples; the business's own parts by its
    // pages: not_offered 0-0.04.
    if (page.odds && offered(page.odds) && !denied(page.odds)) return "page";
    return page.odds === null && !confirmed.length ? "unjudged" : "none";
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
  console.log(`[coverage] ${tenantId}: ${parts.map((p, k) => `${own[k] ? "own" : "foreign"}:${how[k]}${c.priced[k] ? "$" : ""} "${p.slice(0, 60)}"`).join(", ")} (${Date.now() - t0} ms)`);
  (await import("../llm/decision-log.js")).logDecision("coverage", "matcher+jev", { need: need.slice(0, 3000), parts, of }, { own, priced: c.priced, how, items: byItems.map((l) => l.map((i) => i.name.slice(0, 80))), notAsked }, tenantId);
  return c;
}

// The turn's trace for the evals: every coverage the turn used, by need.
type Noted = { need: string; parts: string[] };
function note(need: string, c: Coverage): void {
  const u = turnUsage.getStore();
  if (!u) return;
  const debug = (u.debug ||= {});
  const list = (debug.coverage ||= []) as Noted[];
  if (!list.some((x) => x.need === need.slice(0, 300))) list.push({ need: need.slice(0, 300), parts: c.parts.map((p, k) => `${c.own[k] ? "own" : "foreign"}:${c.how[k]}${c.priced[k] ? "$" : ""} ${p}`) });
}
