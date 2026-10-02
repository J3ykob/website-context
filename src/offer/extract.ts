/**
 * Offer items from text the owner already has: an uploaded price list /
 * catalog (PDF, XLSX, CSV, DOCX, photo) or the scraped website. A model reads
 * the text in blocks; every name it returns must appear in that block and every
 * price's digits too, so nothing is invented. The owner reviews the result
 * before it is saved.
 */
import { clean, type OfferItem } from "./store.js";

export type Llm = (system: string, user: string, maxTokens?: number) => Promise<string>;

function json(raw: string): any {
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  try { return a >= 0 && b > a ? JSON.parse(raw.slice(a, b + 1)) : null; } catch { return null; }
}
const fold = (t: string) => t.toLowerCase().normalize("NFKC");
function digitsOf(t: string): string {
  let d = "";
  for (const ch of t) if (ch >= "0" && ch <= "9") d += ch;
  return d;
}

/** Items from one block of text; kept only when grounded in the block. */
export async function extractFromBlock(block: string, llm: Llm, source: OfferItem["source"]): Promise<OfferItem[]> {
  const out = json(await llm(
    "You extract a business's offer (products and services it sells) from text. Output only JSON.",
    `Text:
"""${block.slice(0, 6000)}"""

List every product or service this business offers that the text names, as
{"items": [{"kind": "product"|"service", "name": "...", "category": "...", "price": "...", "availability": "available"|"on_request"|"unavailable", "description": "..."}]}.
- "name": exactly as written in the text (copy it).
- "price": exactly as written next to it, with currency and unit (e.g. "32,00 zł / worek", "od 150 zł"); "" if the text gives none.
- "category": a short group name in the text's language (from headings if there are any).
- "availability": "available" unless the text says it is unavailable or made to order.
- "description": one short line from the text, or "".
Do not list navigation, contact data, opening hours, news or testimonials. Empty list if the text names no offer.`,
    2500,
  ));
  const text = fold(block);
  const textDigits = digitsOf(block);
  const items: OfferItem[] = [];
  for (const raw of Array.isArray(out?.items) ? out.items : []) {
    const it = clean(raw, source);
    if (!it || !text.includes(fold(it.name))) continue;
    // A price is kept only when its digits appear in the text.
    if (it.price && !textDigits.includes(digitsOf(it.price))) it.price = "";
    items.push(it);
  }
  return items;
}

/** Items from many blocks (a file, or the site's chunks), de-duplicated by name. */
export async function extractFromBlocks(blocks: string[], llm: Llm, source: OfferItem["source"], concurrency = 4): Promise<OfferItem[]> {
  // Merge small blocks so one model call reads up to ~5000 characters.
  const batches: string[] = [];
  let cur = "";
  for (const b of blocks) {
    if (cur && cur.length + b.length > 5000) { batches.push(cur); cur = ""; }
    cur += (cur ? "\n\n" : "") + b;
  }
  if (cur) batches.push(cur);
  const results: OfferItem[][] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (next < batches.length) {
      const k = next++;
      try { results[k] = await extractFromBlock(batches[k], llm, source); }
      catch (e: any) { console.warn(`[offer] extract batch ${k} failed: ${e?.message || e}`); results[k] = []; }
    }
  }));
  const byName = new Map<string, OfferItem>();
  for (const it of results.flat()) {
    const k = it.name.toLowerCase();
    const prev = byName.get(k);
    if (!prev || (!prev.price && it.price)) byName.set(k, prev ? { ...it, id: prev.id } : it);
  }
  return [...byName.values()];
}
