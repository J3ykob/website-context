/**
 * Offer items by meaning: each business's items are embedded once (bge-m3, multilingual - a Ukrainian or
 * French need finds Polish item names), kept in memory and in R2, and embedded again only when the offer
 * changes. nearestItems gives the items closest to a need - a short list for a judge.
 */
import { createHash } from "crypto";
import type { OfferItem } from "./store.js";

const MODEL = "bge-m3";
const memory = new Map<string, { key: string; vecs: Float32Array[] }>();

const itemText = (i: OfferItem) => `${i.name}${i.category ? ` (${i.category})` : ""}${i.description ? ` - ${i.description.slice(0, 160)}` : ""}`;
const offerKey = (items: OfferItem[]) => createHash("sha1").update(`${MODEL}\n${items.map(itemText).join("\n")}`).digest("hex");

function unit(v: number[]): Float32Array {
  const out = new Float32Array(v.length);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let k = 0; k < v.length; k++) out[k] = v[k] / n;
  return out;
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  const { BGEEmbeddingProvider } = await import("../embeddings/bge-provider.js");
  return (await new BGEEmbeddingProvider({ model: MODEL, batchSize: 96 }).embed(texts)).map(unit);
}

async function itemVectors(tenantId: string, items: OfferItem[]): Promise<Float32Array[]> {
  const key = offerKey(items);
  const hit = memory.get(tenantId);
  if (hit?.key === key) return hit.vecs;
  const { downloadFromR2, uploadToR2 } = await import("../storage/r2.js");
  const path = `offer-vectors/${tenantId}.json`;
  try {
    const saved = JSON.parse((await downloadFromR2(path))?.toString("utf-8") || "null");
    if (saved?.key === key && Array.isArray(saved.vecs)) {
      const vecs = saved.vecs.map((b: string) => new Float32Array(new Uint8Array(Buffer.from(b, "base64")).buffer));
      memory.set(tenantId, { key, vecs });
      return vecs;
    }
  } catch {}
  const vecs = await embed(items.map(itemText));
  memory.set(tenantId, { key, vecs });
  await uploadToR2(path, JSON.stringify({ key, vecs: vecs.map((v) => Buffer.from(v.buffer).toString("base64")) }), "application/json").catch(() => {});
  return vecs;
}

/** The `k` items closest to the text by meaning; null when embedding is unavailable. */
export async function nearestItems(tenantId: string, items: OfferItem[], text: string, k: number): Promise<OfferItem[] | null> {
  try {
    const [vecs, [q]] = await Promise.all([itemVectors(tenantId, items), embed([text.slice(0, 2000)])]);
    return vecs.map((v, i) => { let s = 0; for (let d = 0; d < v.length; d++) s += v[d] * q[d]; return { i, s }; })
      .sort((a, b) => b.s - a.s).slice(0, k).map((r) => items[r.i]);
  } catch (e: any) {
    console.warn(`[offer-vectors] ${tenantId}: ${e?.message || e}`);
    return null;
  }
}
