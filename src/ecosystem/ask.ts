/**
 * Ecosystem broadcast. When a business's own content has nothing on a visitor's
 * question, the other businesses of its ecosystem (tenant.settings.ecosystem)
 * are searched and the best few are relayed. Fixed cost per question however
 * many businesses there are - no LLM per business:
 *
 *   1. one small Vectorize query per member (parallel, top 3 of ITS OWN chunks -
 *      a single shared query gets swamped by the biggest catalogue);
 *   2. the CANDIDATES best by similarity go to ONE Jev call that asks, per
 *      excerpt, whether it shows the business offers what was asked - the
 *      excerpts are its closest chunks plus its profile (the offer summary of
 *      its scraped micro-site card: a blog post about X alone doesn't prove the
 *      business sells X, its offer list does);
 *   3. rankMatches: qualified by Jev, ordered with the paid-plan boost, top K;
 *   4. only those K are returned (excerpts + official contact) - the asking bot
 *      writes one reply from them.
 */
import { CloudflareVectorizeStore } from "../embeddings/vectorize-store.js";
import { jevBusinessesOffer, jevUsage } from "../llm/jev.js";
import { listTenants } from "../multi-tenant/tenant-registry.js";
import { rankMatches, planOf, type EcosystemPlan } from "./rank.js";
import type { ChatMessage } from "../llm/chat.js";

export interface EcosystemMatch {
  tenantId: string;
  label: string;
  plan: EcosystemPlan;
  offers: number;
  vector: number;
  passages: { content: string; url: string; title: string }[];
  contact: string;
}

const CANDIDATES = 8;          // businesses judged by Jev (by vector similarity)
const MAX_RELAYED = 3;         // businesses relayed to the visitor
const PASSAGES = 3;            // excerpts per business
const VECTOR_FLOOR = 0.3;      // below this nothing of theirs is about the question
const QUERY_PARALLEL = 25;

export function ecosystemOf(tenant: { settings?: any } | null | undefined): string {
  const e = tenant?.settings?.ecosystem;
  return typeof e === "string" ? e.trim() : "";
}

// "What we offer" in the business's own words: the scraped micro-site card
// (category + first sections), facts from its site only. "" when there is none.
function profileOf(t: { settings?: any }): string {
  const c = t.settings?.siteCard;
  if (!c) return "";
  const parts = [c.eyebrow, ...(Array.isArray(c.sections) ? c.sections.slice(0, 2).map((x: any) => `${x.label}: ${x.text}`) : [])];
  return parts.filter(Boolean).join(" | ").replace(/\s+/g, " ").slice(0, 700);
}

function labelOf(t: { brandName: string | null; domain: string; settings?: any }): string {
  return t.settings?.siteCard?.brand || t.brandName || t.domain.replace(/^www\./, "");
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// Official contact facts from the scrape (context-meta.json), cached briefly.
const contactCache = new Map<string, { at: number; text: string }>();
async function contactOf(tenantId: string): Promise<string> {
  const hit = contactCache.get(tenantId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.text;
  let text = "";
  try {
    const { downloadTenantFile } = await import("../storage/r2.js");
    const buf = await downloadTenantFile(tenantId, "context-meta.json");
    const info = buf ? JSON.parse(buf.toString("utf-8"))?.officialInfo || {} : {};
    text = [
      info.primaryPhone?.value && `phone ${info.primaryPhone.value}`,
      info.primaryEmail?.value && `email ${info.primaryEmail.value}`,
      info.primaryAddress?.value && `address ${info.primaryAddress.value}`,
    ].filter(Boolean).join(", ");
  } catch {}
  contactCache.set(tenantId, { at: Date.now(), text });
  return text;
}

export async function askEcosystem(
  fromTenantId: string,
  ecosystem: string,
  messages: ChatMessage[],
  deps: { embed: (texts: string[]) => Promise<number[][]> },
  onStart?: () => void,
): Promise<EcosystemMatch[]> {
  const question = messages.findLast((m) => m.role === "user")?.content?.trim() || "";
  if (!ecosystem || question.length < 3) return [];
  const members = listTenants().filter((t) => t.id !== fromTenantId && t.status === "active" && ecosystemOf(t) === ecosystem);
  if (members.length === 0) return [];
  onStart?.();
  const t0 = Date.now();

  // 1. Each member's own closest chunks.
  const [vector] = await deps.embed([question]);
  const found = await mapLimited(members, QUERY_PARALLEL, async (m) => {
    try {
      const hits = await new CloudflareVectorizeStore({ tenantId: m.id }).search(vector, PASSAGES);
      return { m, hits: hits.filter((h) => h.content.trim()), best: hits[0]?.score ?? 0 };
    } catch {
      return { m, hits: [], best: 0 };
    }
  });
  const candidates = found
    .filter((f) => f.best >= VECTOR_FLOOR && f.hits.length)
    .sort((a, b) => b.best - a.best)
    .slice(0, CANDIDATES);
  if (candidates.length === 0) return [];

  // 2. One Jev call: does each candidate's own content show it offers this?
  const usage = { inputTokens: 0, calls: 0 };
  const offers = await jevUsage.run(usage, () =>
    jevBusinessesOffer(question, candidates.map((c) => ({ name: labelOf(c.m), passages: [profileOf(c.m), ...c.hits.map((h) => h.content)].filter(Boolean) }))),
  );
  if (!offers) return []; // without Jev nothing is relayed; the asking bot answers honestly itself

  // 3. Rank (qualified by Jev, ordered with plan boosts) and keep the top K.
  const ranked = rankMatches(candidates.map((c, i) => ({ c, offers: offers[i], vector: c.best, plan: planOf(c.m.settings) })), MAX_RELAYED);
  const matches: EcosystemMatch[] = await Promise.all(ranked.map(async (r) => ({
    tenantId: r.c.m.id,
    label: labelOf(r.c.m),
    plan: r.plan,
    offers: r.offers,
    vector: r.vector,
    passages: r.c.hits.map((h) => ({ content: h.content, url: String(h.metadata.url || ""), title: String(h.metadata.title || "") })),
    contact: await contactOf(r.c.m.id),
  })));
  console.log(`[ecosystem] ${fromTenantId}: ${members.length} members, judged ${candidates.map((c, i) => `${c.m.id}=${offers[i].toFixed(2)}`).join(" ")} -> relaying ${matches.map((x) => `${x.tenantId}${x.plan !== "free" ? `(${x.plan})` : ""}`).join(", ") || "none"} | jev ${usage.inputTokens} tok/${usage.calls} call, ${Date.now() - t0}ms`);
  return matches;
}
