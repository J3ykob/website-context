/**
 * Ecosystem ranking. Out of every business that could answer a visitor's
 * question, only the top K are relayed - the others are never asked to answer,
 * which keeps the LLM work at one reply per question however big the ecosystem
 * is, and gives paid placement a clear, bounded meaning:
 *
 *   - QUALIFY on relevance only: a business enters the ranking only if Jev says
 *     its own content shows it offers what was asked (offers >= minOffers). A
 *     plan can never buy a place for a business that doesn't offer it.
 *   - ORDER by offers + plan boost, ties by vector similarity. A paid plan moves
 *     a qualified business ahead of free ones with a comparable offer.
 */

export type EcosystemPlan = "free" | "pro" | "premium";

export const PLAN_BOOST: Record<EcosystemPlan, number> = { free: 0, pro: 0.1, premium: 0.2 };

/** The plan in force for a tenant: settings.ecosystemPlan = { tier, until? } (ISO date). */
export function planOf(settings: any, now: number = Date.now()): EcosystemPlan {
  const p = settings?.ecosystemPlan;
  const tier = p?.tier;
  if (tier !== "pro" && tier !== "premium") return "free";
  if (p.until && !(Date.parse(p.until) > now)) return "free";
  return tier;
}

export interface RankInput {
  offers: number;   // Jev P(the business's content shows it offers what was asked)
  vector: number;   // best vector similarity of its content to the question
  plan: EcosystemPlan;
}

export function rankMatches<T extends RankInput>(items: T[], k = 3, minOffers = 0.5): T[] {
  return items
    .filter((i) => i.offers >= minOffers)
    .map((i) => ({ i, score: i.offers + PLAN_BOOST[i.plan] }))
    .sort((a, b) => b.score - a.score || b.i.vector - a.i.vector)
    .slice(0, k)
    .map((x) => x.i);
}
