/**
 * Intent engine — the CONCRETE, recurring questions visitors ask a tenant's bot
 * ("klienci często pytają: czy oferujecie X"), ranked by frequency, with how
 * often each went unanswered.
 *
 * Built for scale: each visitor question is embedded ONCE (BGE) and assigned to
 * a cluster (chat_messages.intent_id); cluster anchors persist in question_intents.
 * A dashboard load only embeds the NEW (unassigned) messages, not the whole
 * history — cost is proportional to new volume, not total. Frequencies are DERIVED
 * from the assignments (GROUP BY), so re-runs and parallel instances never double
 * count. The canonical question shown is the longest member of a cluster (longest
 * = most complete phrasing) — no per-load LLM call.
 */
import {
  ensureIntentSchema, getUnassignedUserMessages, getIntentAnchors, insertIntentAnchor,
  assignMessagesToIntent, getIntentClusters, getIntentMembers, getUnknownQuestions,
  type IntentAnchorRow,
} from "../storage/conversation-store.js";
import { BGEEmbeddingProvider } from "../embeddings/bge-provider.js";

export interface RecurringQuestion {
  question: string;   // canonical phrasing, in the visitor's language
  count: number;      // how many times this intent was asked
  gapCount: number;   // how many matching gap-journal entries (often-unanswered signal)
  examples: string[]; // a couple of other real phrasings in the cluster
}
export interface IntentAnalysis {
  intents: RecurringQuestion[];
  totalQuestions: number;  // total assigned visitor questions
  distinctIntents: number; // number of clusters
  analyzedAt: string;
}

const SIM_THRESHOLD = 0.82;   // cosine: same-intent paraphrases cluster together
const TOP_N = 15;             // recurring questions surfaced to the owner
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry { analysis: IntentAnalysis; at: number }
const cache = new Map<string, CacheEntry>();
// Gap embeddings are re-embedded only when the journal size changes (bounded ≤200).
const gapEmbedCache = new Map<string, { count: number; items: { q: string; emb: number[] }[] }>();

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
function isMeaningful(content: string): boolean {
  const c = content.trim();
  if (c.length < 3) return false;
  if (/^(hi|hej|hey|hello|cześć|siema|dzień dobry|witam|test|ok|okay|thx|dzięki|thanks|spoko|no|tak|yes)[\s!.,?]*$/i.test(c)) return false;
  return true;
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function bestAnchor(emb: number[], anchors: IntentAnchorRow[]): { anchor: IntentAnchorRow; sim: number } | null {
  let best: IntentAnchorRow | null = null, bestSim = -1;
  for (const a of anchors) {
    const s = cosine(emb, a.embedding);
    if (s > bestSim) { bestSim = s; best = a; }
  }
  return best && bestSim >= SIM_THRESHOLD ? { anchor: best, sim: bestSim } : null;
}

/**
 * Incremental clustering pass: embed the unassigned visitor messages, attach each
 * to an existing cluster or start a new one. Returns the (updated) anchor set.
 */
async function updateClusters(tenantId: string, provider: BGEEmbeddingProvider): Promise<IntentAnchorRow[]> {
  await ensureIntentSchema();
  const anchors = await getIntentAnchors(tenantId);

  const pending = (await getUnassignedUserMessages(tenantId, 400))
    .filter((m) => isMeaningful(m.content));
  if (pending.length === 0) return anchors;

  const embeddings = await provider.embed(pending.map((m) => m.content));

  const assignBatches = new Map<string, string[]>(); // intentId -> messageIds
  const pushAssign = (intentId: string, msgId: string) => {
    const arr = assignBatches.get(intentId) || [];
    arr.push(msgId);
    assignBatches.set(intentId, arr);
  };

  const newAnchors: { id: string; canonical: string; embedding: number[] }[] = [];
  const seenNormNew = new Map<string, string>(); // exact-dup guard within batch -> intentId

  for (let i = 0; i < pending.length; i++) {
    const msg = pending[i];
    const emb = embeddings[i] || [];
    if (emb.length === 0) continue;

    const norm = normalize(msg.content);
    const dupIntent = seenNormNew.get(norm);
    if (dupIntent) { pushAssign(dupIntent, msg.id); continue; }

    const match = bestAnchor(emb, anchors);
    if (match) {
      pushAssign(match.anchor.id, msg.id);
      seenNormNew.set(norm, match.anchor.id);
    } else {
      const id = globalThis.crypto?.randomUUID?.() || `int-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const anchor: IntentAnchorRow = { id, canonical: msg.content, embedding: emb };
      anchors.push(anchor);              // available to later messages in this batch
      newAnchors.push({ id, canonical: msg.content, embedding: emb });
      pushAssign(id, msg.id);
      seenNormNew.set(norm, id);
    }
  }

  // Persist: new anchors, then the assignments (batched per cluster).
  for (const a of newAnchors) await insertIntentAnchor(tenantId, a.id, a.canonical, a.embedding);
  for (const [intentId, ids] of assignBatches) await assignMessagesToIntent(tenantId, ids, intentId);

  return anchors;
}

async function gapCountsByIntent(
  tenantId: string, anchors: IntentAnchorRow[], provider: BGEEmbeddingProvider
): Promise<Map<string, number>> {
  const gaps = (await getUnknownQuestions(tenantId)).map((g) => g.question).filter(Boolean);
  const counts = new Map<string, number>();
  if (gaps.length === 0 || anchors.length === 0) return counts;

  let cached = gapEmbedCache.get(tenantId);
  if (!cached || cached.count !== gaps.length) {
    const embs = await provider.embed(gaps);
    cached = { count: gaps.length, items: gaps.map((q, i) => ({ q, emb: embs[i] || [] })) };
    gapEmbedCache.set(tenantId, cached);
  }
  for (const g of cached.items) {
    const m = bestAnchor(g.emb, anchors);
    if (m) counts.set(m.anchor.id, (counts.get(m.anchor.id) || 0) + 1);
  }
  return counts;
}

/** Public: cached, concrete recurring-question analysis for a tenant. */
export async function analyzeIntents(tenantId: string, opts: { force?: boolean } = {}): Promise<IntentAnalysis> {
  const cached = cache.get(tenantId);
  if (!opts.force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.analysis;

  const provider = new BGEEmbeddingProvider();
  let analysis: IntentAnalysis;
  try {
    const anchors = await updateClusters(tenantId, provider);
    const clusters = await getIntentClusters(tenantId, 40);
    const gapMap = await gapCountsByIntent(tenantId, anchors, provider);
    const total = clusters.reduce((s, c) => s + c.count, 0);

    const top = clusters.slice(0, TOP_N);
    const intents: RecurringQuestion[] = [];
    for (const c of top) {
      const members = await getIntentMembers(tenantId, c.intentId, 4);
      const canonical = members[0] || anchorCanonical(anchors, c.intentId) || "(question)";
      intents.push({
        question: canonical,
        count: c.count,
        // gap matches are a proxy; never show more "unanswered" than times asked
        gapCount: Math.min(gapMap.get(c.intentId) || 0, c.count),
        examples: members.slice(1, 3),
      });
    }
    analysis = { intents, totalQuestions: total, distinctIntents: clusters.length, analyzedAt: new Date().toISOString() };
  } catch (e: any) {
    console.error(`[intent-engine] failed (${tenantId}): ${String(e?.message || e).slice(0, 160)}`);
    return cached?.analysis || { intents: [], totalQuestions: 0, distinctIntents: 0, analyzedAt: new Date().toISOString() };
  }

  cache.set(tenantId, { analysis, at: Date.now() });
  return analysis;
}

function anchorCanonical(anchors: IntentAnchorRow[], id: string): string | null {
  const a = anchors.find((x) => x.id === id);
  return a ? a.canonical : null;
}

/** Ops seam: drop caches (e.g. after a gap-journal purge). */
export function invalidateIntents(tenantId?: string): void {
  if (tenantId) { cache.delete(tenantId); gapEmbedCache.delete(tenantId); }
  else { cache.clear(); gapEmbedCache.clear(); }
}
