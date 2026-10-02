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

/** The items the message is about, best first (at most `limit`). [] when none / Jev down. */
export async function findOfferItems(question: string, items: OfferItem[], limit = 8): Promise<OfferItem[]> {
  if (!items.length || !question.trim()) return [];
  let pool = items;
  if (items.length > DIRECT_MAX) {
    const cats = [...new Set(items.map((i) => i.category).filter(Boolean))].slice(0, 60);
    const cs = await judge(question, cats, "categories");
    if (!cs) return [];
    const picked = new Set(cats.filter((_, k) => cs[k] >= 0.4));
    pool = items.filter((i) => picked.has(i.category)).slice(0, DIRECT_MAX);
    if (!pool.length) return [];
  }
  const label = (i: OfferItem) => `${i.name}${i.category ? ` (${i.category})` : ""}`;
  const scores = await judge(question, pool.map(label), "items");
  if (!scores) return [];
  return pool
    .map((it, k) => ({ it, s: scores[k] }))
    .filter((r) => r.s >= ITEM_MIN)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.it);
}
