/**
 * Which businesses of the network have what a customer needs - ONE search for both sides (the owner's
 * point, 2026-10-29: the chat's "who else has it?" and the request broadcast "who can quote this part?"
 * are the same question; they were two code paths with their own shortlists and judging).
 *
 *   1. the need as parts (one product or service each; one call; a single-item need is one part);
 *   2. per part, a shortlist from the capability index (src/network/capability-index.ts) - one query, any
 *      network size; without index records, every member;
 *   3. per candidate, its evidence: the offer items that match the part (with prices) and its own closest
 *      page excerpts;
 *   4. per part, ONE Jev judgement over all candidates' evidence: does this business offer it?
 *   5. ranking per part: a priced match first, then Jev's confidence, plus the paid-plan boost.
 *
 * The chat relays the best few (with their excerpts and contact); the customer's project takes the picked
 * businesses per part as its network offers (priced items are prices; the rest are asked for one). No model
 * writes an answer per business any more - the matched items and excerpts are the offer.
 */
import type { OfferItem } from "../offer/store.js";
import type { EcosystemPlan } from "../ecosystem/rank.js";

export interface BusinessHit {
  tenantId: string;
  label: string;
  part: number;
  offers: number;           // Jev: P(this business offers the part)
  precise: boolean;         // a matched item with a price
  items: OfferItem[];       // matched offer items (priced first)
  passages: { content: string; url: string; title: string }[];
  plan: EcosystemPlan;
  vector: number;           // index similarity
  text: string;             // the offer as data: matched items with prices, or what its pages say
}
export interface FindResult { parts: string[]; hits: BusinessHit[]; asked: number; ms: number }

const PER_PART = () => Number(process.env.NETWORK_SHORTLIST_PART) || 6;
const MIN_OFFERS = 0.5;

/**
 * The businesses for a need. `include`: a business that always competes (the one running a project);
 * `exclude`: never (the one whose chat asks). `parts`: already split. Never throws.
 */
export async function findBusinesses(need: string, ecosystem: string, opts: { include?: string; exclude?: string; parts?: string[]; perPart?: number } = {}): Promise<FindResult> {
  const t0 = Date.now();
  const empty = (parts: string[] = []): FindResult => ({ parts, hits: [], asked: 0, ms: Date.now() - t0 });
  if (!ecosystem || !need.trim()) return empty();
  const { listTenants, getTenant } = await import("../multi-tenant/d1-registry.js");
  const members = listTenants().filter((t: any) => t.status === "active" && t.settings?.ecosystem === ecosystem && t.id !== opts.exclude);
  if (!members.length) return empty();
  const { splitNeed } = await import("../projects/broadcast.js");
  const parts = opts.parts ?? (await splitNeed(need).catch(() => [] as string[]));
  if (!parts.length) return empty(parts);

  const { BGEEmbeddingProvider } = await import("../embeddings/bge-provider.js");
  const vecs = await new BGEEmbeddingProvider({ model: "bge-m3" }).embed(parts).catch(() => null);
  if (!vecs) return empty(parts);
  const { searchNetwork } = await import("./capability-index.js");
  const { loadOffer, renderItem } = await import("../offer/store.js");
  const { offerMatches, businessLabel } = await import("../projects/network.js");
  const { CloudflareVectorizeStore } = await import("../embeddings/vectorize-store.js");
  const { jevBusinessesOffer } = await import("../llm/jev.js");
  const { planOf, PLAN_BOOST } = await import("../ecosystem/rank.js");
  const memberIds = new Set(members.map((m: any) => m.id));
  const asked = new Set<string>();

  const perPart = await Promise.all(parts.map(async (part, k) => {
    // 2. shortlist (the index; all members when it has nothing for this network)
    const short = await searchNetwork(ecosystem, part, { vector: vecs[k], limit: opts.perPart || PER_PART(), exclude: opts.exclude ? [opts.exclude] : [] }).catch(() => null);
    const scoreOf = new Map((short || []).map((s) => [s.tenant, s.score]));
    let ids = short ? short.map((s) => s.tenant).filter((id) => memberIds.has(id)) : [...memberIds];
    if (opts.include && memberIds.has(opts.include) && !ids.includes(opts.include)) ids = [opts.include, ...ids];
    ids.forEach((id) => asked.add(id));
    // 3. evidence per candidate: matched items (with prices) and its own closest excerpts
    const ev = await Promise.all(ids.map(async (id) => {
      const items = (await loadOffer(id).catch(() => null))?.items || [];
      const matched = items.length ? ((await offerMatches(id, items, part).catch(() => null)) || []) : [];
      // A priced offer only from the best matches (they come best first): a loose match is not a quote.
      const hits = await new CloudflareVectorizeStore({ tenantId: id }).search(vecs[k], 3).catch(() => []);
      const passages = hits.filter((h) => h.content.trim()).map((h) => ({ content: h.content, url: String(h.metadata.url || ""), title: String(h.metadata.title || "") }));
      return { id, items: matched, precise: matched.slice(0, 2).some((i) => i.price_value !== null), passages };
    }));
    // 4. one judgement for all candidates of this part
    const label = (id: string) => businessLabel(id);
    const evidence = ev.map((e) => ({ name: label(e.id), passages: [...e.items.slice(0, 4).map((i) => renderItem(i).slice(0, 600)), ...e.passages.map((p) => p.content)].slice(0, 5) }));
    // Our own deterministic model first (src/network/rerank.ts); Jev when it is unreachable.
    const { rerankBusinesses, RERANK_MIN } = await import("./rerank.js");
    const rr = await rerankBusinesses(part, evidence);
    const scores = rr ?? (await jevBusinessesOffer(part, evidence).catch(() => null));
    const minOffers = rr ? RERANK_MIN() : MIN_OFFERS;
    if (!scores) return [] as BusinessHit[];
    // 4b. A price is an offer only for the thing asked: every priced item of the qualified candidates is
    // judged (one call per part) - "is this item the product or service the part asks for, not a component,
    // a related job or a substitute?". Bathroom renovation priced from a screed and a paint job was quoted
    // as a partial bathroom price (chain test C17); the per-business model answer used to make this call.
    const priced = ev.flatMap((e, i) => (scores[i] >= minOffers ? e.items.filter((it) => it.price_value !== null).slice(0, 3).map((it) => ({ e, it })) : []));
    const { jevAsk } = await import("../llm/jev.js");
    const same = priced.length ? await jevAsk({ part_asked: part, items: priced.map((x) => renderItem(x.it).slice(0, 300)) },
      Object.fromEntries(priced.map((_, j) => [`i${j}`, { type: "noul" as const, instructions: `Is \`items[${j}]\` the product or service that \`part_asked\` asks for (the same thing, so its price prices that part) - not a component of it, a related or partial job, or a substitute of another kind?` }])), 8000).catch(() => null) : null;
    // Only priced items judged to be the thing asked keep a place (unjudged ones beyond the first 3 slipped
    // through and the agent quoted silicone and skirting as a bathroom price - C17).
    const isIt = new Set(priced.filter((_, j) => (((same as any)?.[`i${j}`]?.noul as number) ?? 0) >= 0.5).map((x) => x.it));
    for (const e of ev) { e.items = e.items.filter((it) => it.price_value === null || isIt.has(it)); e.precise = e.items.slice(0, 2).some((it) => it.price_value !== null); }
    // 5. qualified, ranked
    return ev.map((e, i): BusinessHit => ({
      tenantId: e.id, label: label(e.id), part: k, offers: scores[i], precise: e.precise, items: e.items, passages: e.passages,
      plan: planOf(getTenant(e.id)?.settings), vector: scoreOf.get(e.id) ?? 0,
      text: e.items.length ? e.items.slice(0, 4).map((it) => renderItem(it).slice(0, 300)).join("\n") : `${e.passages[0]?.content.replace(/\s+/g, " ").slice(0, 300) || ""} (cena do ustalenia)`,
    })).filter((h) => h.offers >= minOffers)
      .sort((a, b) => Number(b.precise) - Number(a.precise) || (b.offers + PLAN_BOOST[b.plan]) - (a.offers + PLAN_BOOST[a.plan]) || b.vector - a.vector);
  }));
  const hits = perPart.flat();
  console.log(`[network-find] ${ecosystem}: ${parts.length} part(s), ${asked.size} judged of ${members.length} -> ${hits.map((h) => `${h.part + 1}:${h.tenantId}${h.precise ? "$" : ""}`).join(" ") || "none"} (${Date.now() - t0} ms)`);
  return { parts, hits, asked: asked.size, ms: Date.now() - t0 };
}
