/**
 * Offer items from a file that is NOT our onboarding spreadsheet (a price list
 * or catalog as PDF / XLSX / CSV / DOCX / photo). A model reads the text in
 * blocks and fills the schema; every name must appear in the text and every
 * price's digits too, field values must be schema values, so nothing is
 * invented. The owner reviews the result before it is saved. (Our own
 * spreadsheet is read column by column, no model - see sheet.ts.)
 */
import { clean, type OfferItem } from "./store.js";
import { FIELDS, type FieldId } from "./schema.js";

export type Llm = (system: string, user: string, maxTokens?: number) => Promise<string>;

function json(raw: string): any {
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  try { return a >= 0 && b > a ? JSON.parse(raw.slice(a, b + 1)) : salvage(raw); } catch { return salvage(raw); }
}
/**
 * A reply cut off mid-way (output limit): keep every complete object of the
 * "items" array, found by scanning characters (brace depth, strings skipped).
 */
function salvage(raw: string): any {
  const start = raw.indexOf("[");
  if (start < 0) return null;
  const items: any[] = [];
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let k = start + 1; k < raw.length; k++) {
    const ch = raw[k];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) objStart = k; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && objStart >= 0) { try { items.push(JSON.parse(raw.slice(objStart, k + 1))); } catch {} objStart = -1; } }
    else if (ch === "]" && depth === 0) break;
  }
  return items.length ? { items } : null;
}
const fold = (t: string) => t.toLowerCase().normalize("NFKC");
function digitsOf(t: string): string {
  let d = "";
  for (const ch of t) if (ch >= "0" && ch <= "9") d += ch;
  return d;
}
const FIELD_SPEC = (Object.keys(FIELDS) as FieldId[]).map((f) => `"${f}": ${Object.keys(FIELDS[f].values).map((v) => `"${v}"`).join("|")}`).join(",\n    ");

/** Items from one block of text; kept only when grounded in the block. */
export async function extractFromBlock(block: string, llm: Llm, source: OfferItem["source"]): Promise<OfferItem[]> {
  const out = json(await llm(
    "You extract a business's offer (products and services it sells) from text into a fixed schema. Output only JSON.",
    `Text:
"""${block.slice(0, 6000)}"""

List every product or service this business offers that the text names, as
{"items": [{"name": "...", "category": "...", "description": "...", "price_value": number|null, "price_max": number|null, "currency": "PLN",
  "fields": {
    ${FIELD_SPEC}
  },
  "components": [{"label": "...", "price_type": "...", "price_value": number|null, "price_max": number|null, "unit": "...", "quantity_from": "fixed"|"customer", "quantity_label": "...", "combine": "sum"|"alternative"}]
}]}
- "name": the item's short name as the text writes it, like a heading or list entry (copy it; at most ~8 words) - never a descriptive sentence. List each item once, even if the text mentions it several times. "category": from the text's headings, in its language.
- "price_value": the number written next to the item (the lower end for a range), null if none. Never compute or guess.
- "fields": choose only from the listed values, and only when the text STATES it for this item (e.g. "dostawa gratis", "od ręki", "cena do uzgodnienia"). Never assume a typical value for this kind of business: if the text does not say, use "unknown" (an empty answer is better than a wrong one).
- "components": only when the text itself gives the item several prices: parts that add up (design + labour per m² + materials -> "combine": "sum"), or alternative rates the customer picks from (per hour / per day -> "combine": "alternative"; then also set price_value to the lowest rate). Otherwise [].
List the concrete products / services this text presents (e.g. each machine, each model, each service with its own price) - not the names of other categories or pages it links to. Do not list navigation, contact data, opening hours, news or testimonials. Empty list if the text names no offer.`,
    6000,
  ));
  const text = fold(block);
  const textDigits = digitsOf(block);
  const items: OfferItem[] = [];
  for (const raw of Array.isArray(out?.items) ? out.items : []) {
    const it = clean(raw, source);
    if (!it || !text.includes(fold(it.name))) continue;
    // A number is kept only when its digits appear in the text.
    const grounded = (n: number | null) => n !== null && textDigits.includes(digitsOf(String(n).split(".").join("")).slice(0, 6));
    if (!grounded(it.price_value)) it.price_value = null;
    if (!grounded(it.price_max)) it.price_max = null;
    it.components = it.components.map((c) => ({ ...c, price_value: grounded(c.price_value) ? c.price_value : null, price_max: grounded(c.price_max) ? c.price_max : null }));
    if (it.price_value !== null && it.price_max !== null && it.price_max < it.price_value) [it.price_value, it.price_max] = [it.price_max, it.price_value];
    it.components = it.components.map((c) => (c.price_value !== null && c.price_max !== null && c.price_max < c.price_value ? { ...c, price_value: c.price_max, price_max: c.price_value } : c));
    if (it.price_value === null && ["fixed", "from", "range", "per_unit"].includes(it.fields.price_type || "")) delete it.fields.price_type;
    items.push(it);
  }
  return items;
}

/** Items from many blocks (a file), de-duplicated by name. */
export async function extractFromBlocks(blocks: string[], llm: Llm, source: OfferItem["source"], concurrency = 4): Promise<OfferItem[]> {
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
    if (!prev || (prev.price_value === null && it.price_value !== null)) byName.set(k, prev ? { ...it, id: prev.id } : it);
  }
  return [...byName.values()];
}
