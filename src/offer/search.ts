/**
 * Which offer items a customer's message is about. Language-agnostic: Jev
 * judges the item names against the message (a French or Ukrainian question
 * finds Polish item names). Large offers go category first, then items.
 */
import { jevAsk, type JevQuestion } from "../llm/jev.js";
import type { OfferItem } from "./store.js";

const DIRECT_MAX = 80; // up to this many items are judged in one Jev call
const ITEM_MIN = 0.5;

async function judge(question: string, labels: string[], what: string): Promise<number[] | null> {
  if (!labels.length) return [];
  const a = await jevAsk({ customer_message: question, [what]: labels }, Object.fromEntries(labels.map((_, k) => [`x${k}`, {
    type: "noul",
    instructions: what === "items"
      ? `Is \`items[${k}]\` something \`customer_message\` asks about or wants (that product or service, its price, availability or details), in any language?`
      : `Could what \`customer_message\` asks about or wants belong to the category \`categories[${k}]\`, in any language?`,
  } as JevQuestion])), 6000);
  if (!a) return null;
  return labels.map((_, k) => ((a[`x${k}`] as any)?.noul as number) ?? 0);
}

/** Lower-case words of 3+ letters (split on anything that is not a letter or digit). */
export function words(t: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of t.toLowerCase() + " ") {
    if (ch.toLowerCase() !== ch.toUpperCase() || (ch >= "0" && ch <= "9")) cur += ch;
    else { if (cur.length >= 3) out.push(cur); cur = ""; }
  }
  return out;
}

/** The items the message is about, best first (at most `limit`). [] when none / Jev down. */
export async function findOfferItems(question: string, items: OfferItem[], limit = 8, minScore = ITEM_MIN): Promise<OfferItem[]> {
  return (await matchOfferItems(question, items, limit, minScore)) ?? [];
}

/** Like matchOfferItems, with each item's score (best first) - to order matches from several batches. */
export async function matchOfferItemsScored(question: string, items: OfferItem[], minScore = ITEM_MIN): Promise<{ item: OfferItem; score: number }[] | null> {
  if (!items.length || !question.trim()) return [];
  const label = (i: OfferItem) => `${i.name}${i.category ? ` (${i.category})` : ""}${i.source === "shop" && i.description.startsWith("SKU: ") ? ` [${i.description.slice(0, i.description.indexOf(".") > 0 ? i.description.indexOf(".") : 40)}]` : ""}`;
  const scores = await judge(question, items.map(label), "items");
  if (!scores) return null;
  return items.map((item, k) => ({ item, score: scores[k] })).filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score);
}

/** Like findOfferItems, but null when the items could not be judged (Jev down), [] when none match. */
export async function matchOfferItems(question: string, items: OfferItem[], limit = 8, minScore = ITEM_MIN): Promise<OfferItem[] | null> {
  if (!items.length || !question.trim()) return [];
  // A shop's products carry their SKU: a customer may ask by catalogue number ("2200968").
  const label = (i: OfferItem) => `${i.name}${i.category ? ` (${i.category})` : ""}${i.source === "shop" && i.description.startsWith("SKU: ") ? ` [${i.description.slice(0, i.description.indexOf(".") > 0 ? i.description.indexOf(".") : 40)}]` : ""}`;
  let pool = items;
  if (items.length > DIRECT_MAX) {
    const cats = [...new Set(items.map((i) => i.category).filter(Boolean))].slice(0, 150);
    const cs = await judge(question, cats, "categories");
    if (!cs) return null;
    const picked = new Set(cats.filter((_, k) => cs[k] >= 0.4));
    // Plus items sharing a word with the question (5-letter stems, so Polish
    // inflection matches: "ubijaka" ~ "Ubijak"), in case the category missed it.
    const stems = new Set(words(question).map((w) => w.slice(0, 5)));
    const lexical = items
      .map((i) => ({ i, n: words(i.name).filter((w) => stems.has(w.slice(0, 5))).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 30)
      .map((x) => x.i);
    pool = [...new Set([...lexical, ...items.filter((i) => picked.has(i.category))])].slice(0, DIRECT_MAX);
    if (!pool.length) return [];
  }
  const scores = await judge(question, pool.map(label), "items");
  if (!scores) return null;
  return pool
    .map((it, k) => ({ it, s: scores[k] }))
    .filter((r) => r.s >= minScore)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.it);
}
