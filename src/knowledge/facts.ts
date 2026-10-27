/**
 * Key facts: every sentence of the site (with its page title) embedded on its own, so a fact written
 * once - "W naszej ofercie (wynajem i zakup)… MiniBox", "Koszt inwestycji to 12,5 mln zł" - is found
 * even when its page loses in page selection (2026-10-27: 7/7 missed facts in the top 25 sentences,
 * all kept by a Jev check). Built after each scrape; stored per tenant in R2 as compact int8 vectors
 * (facts.json + facts.bin), kept in a small in-memory LRU.
 */
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { KnowledgeCatalog } from "./catalog.js";
import { SENTENCE_END, jevAsk, type JevNoulAnswer } from "../llm/jev.js";

const MAX_SENTENCES = 4000;
const ARTICLE = /\/(blog|aktualnosci|news|poradnik|porady|artykul|artykuly|wpis)(\/|$|-)/i;

export interface FactIndex { sentences: { s: string; url: string }[]; dim: number; vecs: Int8Array; scales: Float32Array }

/** The site's sentences, each with its page title; offer pages before blog posts; duplicates dropped. */
export function factSentences(catalog: KnowledgeCatalog): { s: string; url: string }[] {
  const chunks = [...catalog.chunks].sort((a, b) => Number(ARTICLE.test(a.url)) - Number(ARTICLE.test(b.url)));
  const out: { s: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const ch of chunks) {
    const title = (ch.title || "").replace(/\s*[-|–]\s*[^-|–]*$/, "").trim().slice(0, 80);
    for (const line of ch.content.replace(/\s*Keywords:[^\n]*/i, "").split(/\n+/)) {
      for (const part of line.split(SENTENCE_END).filter((_, i) => i % 3 === 0 && _)) {
        const x = part.replace(/\|/g, " ").replace(/^[#>*\s-]+/, "").replace(/\s+/g, " ").trim();
        if (x.length < 12 || seen.has(x)) continue;
        seen.add(x);
        out.push({ s: `${title ? `${title}: ` : ""}${x.slice(0, 400)}`, url: ch.url });
        if (out.length >= MAX_SENTENCES) return out;
      }
    }
  }
  return out;
}

function quantize(vecs: number[][]): { vecs: Int8Array; scales: Float32Array; dim: number } {
  const dim = vecs[0]?.length || 0;
  const out = new Int8Array(vecs.length * dim);
  const scales = new Float32Array(vecs.length);
  vecs.forEach((v, i) => {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    const max = Math.max(...v.map((x) => Math.abs(x / norm))) || 1;
    scales[i] = max / 127;
    for (let k = 0; k < dim; k++) out[i * dim + k] = Math.round((v[k] / norm / max) * 127);
  });
  return { vecs: out, scales, dim };
}

export async function buildFactIndex(tenantId: string, catalog: KnowledgeCatalog, embeddings: EmbeddingProvider): Promise<number> {
  const sentences = factSentences(catalog);
  if (!sentences.length) return 0;
  const q = quantize(await embeddings.embed(sentences.map((x) => x.s)));
  const { uploadToR2 } = await import("../storage/r2.js");
  const bin = Buffer.concat([Buffer.from(q.scales.buffer), Buffer.from(q.vecs.buffer)]);
  await uploadToR2(`tenants/${tenantId}/facts.bin`, bin, "application/octet-stream");
  await uploadToR2(`tenants/${tenantId}/facts.json`, JSON.stringify({ dim: q.dim, n: sentences.length, sentences }), "application/json");
  cache.delete(tenantId);
  return sentences.length;
}

// Loaded indexes, least recently used dropped beyond ~120 MB.
const cache = new Map<string, FactIndex | null>();
const BUDGET = 120 * 1024 * 1024;
async function load(tenantId: string): Promise<FactIndex | null> {
  if (cache.has(tenantId)) { const v = cache.get(tenantId)!; cache.delete(tenantId); cache.set(tenantId, v); return v; }
  const { downloadTenantFile } = await import("../storage/r2.js");
  const [j, b] = await Promise.all([downloadTenantFile(tenantId, "facts.json").catch(() => null), downloadTenantFile(tenantId, "facts.bin").catch(() => null)]);
  let idx: FactIndex | null = null;
  if (j && b) {
    const meta = JSON.parse(j.toString("utf-8"));
    const n = meta.n as number, dim = meta.dim as number;
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    idx = { sentences: meta.sentences, dim, scales: new Float32Array(ab, 0, n), vecs: new Int8Array(ab, n * 4, n * dim) };
  }
  cache.set(tenantId, idx);
  let total = 0;
  for (const v of cache.values()) total += v ? v.vecs.byteLength : 0;
  for (const k of cache.keys()) { if (total <= BUDGET) break; const v = cache.get(k); total -= v ? v.vecs.byteLength : 0; cache.delete(k); }
  return idx;
}

/**
 * The sentences that bear on the customer's latest message: nearest by meaning (top 25), then Jev keeps
 * the ones that answer it or bear directly on it (at most `max`). Null when the tenant has no index yet.
 */
export async function keyFacts(tenantId: string, queryVec: number[] | null, conversation: string, question: string, max = 8): Promise<{ s: string; url: string }[] | null> {
  if (!queryVec) return null;
  const idx = await load(tenantId).catch(() => null);
  if (!idx || !idx.sentences.length) return null;
  const qn = Math.sqrt(queryVec.reduce((s, x) => s + x * x, 0)) || 1;
  const scores = new Float32Array(idx.sentences.length);
  for (let i = 0; i < idx.sentences.length; i++) {
    let dot = 0;
    const off = i * idx.dim;
    for (let k = 0; k < idx.dim; k++) dot += idx.vecs[off + k] * queryVec[k];
    scores[i] = (dot * idx.scales[i]) / qn;
  }
  const top = [...scores.keys()].sort((a, b) => scores[b] - scores[a]).slice(0, 25).map((i) => idx.sentences[i]);
  const state: Record<string, string> = { conversation, question };
  const qs: Record<string, any> = {};
  top.forEach((x, i) => { state[`s${i}`] = x.s; qs[`k${i}`] = { type: "noul", instructions: `Does \`s${i}\` (a sentence from the business's website) state something that answers the customer's latest message (\`question\`, read with \`conversation\`) or part of it, or bears directly on it?` }; });
  const a = await jevAsk(state, qs, 5000).catch(() => null);
  if (!a) return [];
  return top.map((x, i) => ({ x, p: (a[`k${i}`] as JevNoulAnswer | undefined)?.noul ?? 0 })).filter((y) => y.p >= 0.5).sort((m, n) => n.p - m.p).slice(0, max).map((y) => y.x);
}
