/**
 * Which offer items a customer's message is about (text -> structure, by a model). The items nearest
 * by meaning (bge-m3 vectors, any language; per part of a split request too) make a short list; one
 * pinned model call returns the ids of the items that ARE what the message asks for - and, when asked,
 * the quantities the customer gave for each item's price inputs (src/offer/quantities.ts prices them in code).
 *
 * Was Jev judging item names one by one (2026-10-30, 40 hand-labelled messages, 7 businesses): Jev found
 * the right item 28/30, 25% of what it returned was wrong, trestles matched compactors, 23/40 identical
 * across runs. This, deepseek-v4.1-flash: 30/30, 9/10 messages with no item clean, 21% neighbouring items,
 * every quantity right (C9 15 x 240, C14 30 h = 2 days, C19 6 h = the daily rate), 0.9 s median; Haiku 5.5
 * 30/30, 16%, missed quantities and read "grunt pod podłogę" (primer) as the floor, 2.3 s. The bge reranker
 * scores customer sentences ~0 (fine only on short phrases) - not usable here.
 */
import { createHash } from "crypto";
import type { OfferItem } from "./store.js";

const MODEL = process.env.ITEMS_MODEL || "deepseek/deepseek-v4.1-flash"; // pinned provider + seed (llm/pin.ts)
const DIRECT_MAX = 80; // up to this many items go to the model as they are
const SHORTLIST = 40; // larger offers: the nearest by meaning
const PER_PART = 30; // and for a request of several parts, the nearest to each part
const POOL_MAX = 100; // items the model sees at most
const CAT_FROM = 8; // the nearest items whose whole category joins the list
const PER_CATEGORY = 25; // items of one category at most
const TIMEOUT_MS = 8000;

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

/** The first complete JSON object in a model's answer (some add text or a second object after it). */
function firstJson(c: string): any {
  const start = c.indexOf("{");
  if (start < 0) throw new Error("no JSON");
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < c.length; k++) {
    const ch = c[k];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(c.slice(start, k + 1));
  }
  throw new Error("unfinished JSON");
}

const label = (i: OfferItem) => `${i.name}${i.category ? ` (${i.category})` : ""}${i.description ? ` - ${i.description.slice(0, 150)}` : ""}`;

export interface ItemMatch { items: OfferItem[]; given: Map<OfferItem, Record<string, number>> }
export interface MatchOptions {
  limit?: number;
  /** The business whose whole offer `items` is (its vectors are cached per business); otherwise per item text. */
  tenant?: string;
  /** Also read the customer's quantities for the picked items' price inputs. */
  quantities?: boolean;
  /** The message is one part of a split request already (the network): no split for the short list. */
  onePart?: boolean;
}

// The same message against the same items gets the same answer for an hour (models vary run to run).
const recent = new Map<string, { at: number; ids: number[]; q: { id: number; input: string; value: number }[] }>();
const RECENT_MS = 60 * 60 * 1000;

/** The items the message is about, best first; null when the model could not be asked. */
export async function matchItems(question: string, items: OfferItem[], opts: MatchOptions = {}): Promise<ItemMatch | null> {
  const limit = opts.limit ?? 8;
  if (!items.length || !question.trim()) return { items: [], given: new Map() };
  if (!process.env.OPENROUTER_API_KEY) return null;
  let pool = items;
  if (items.length > DIRECT_MAX) {
    // A message asking for several things: the nearest to the whole message are all of one of them ("vinyl
    // floor 25 m2 and a primer for it" - 40 floors, no primer), so each part of the split request
    // (projects/broadcast.ts splitNeed, stored per request) gets its own nearest too.
    const v = await import("./vectors.js");
    const near = (text: string, k: number) => (opts.tenant ? v.nearestItems(opts.tenant, items, text, k) : v.nearestOf(items, text, k));
    const [whole, parts] = await Promise.all([
      near(question, SHORTLIST),
      opts.onePart ? Promise.resolve([] as string[]) : import("../projects/broadcast.js").then((b) => b.splitNeed(question)).catch(() => [] as string[]),
    ]);
    if (!whole) return null;
    const perPart = parts.length > 1 ? await Promise.all(parts.slice(0, 4).map((p) => near(p, PER_PART))) : [];
    const nearest = [...new Set([...perPart.flatMap((x) => (x || []).slice(0, PER_PART)), ...whole])];
    // Vectors miss a job's tool ("ubić podjazd" finds the rammers, not one plate compactor: "Zagęszczarka
    // 90 kg, silnik Honda" reads nothing like it), so the categories of the nearest items come whole.
    const cats = [...new Set(nearest.slice(0, CAT_FROM).map((i) => i.category).filter(Boolean))];
    const siblings = cats.flatMap((c) => items.filter((i) => i.category === c).slice(0, PER_CATEGORY));
    pool = [...new Set([...nearest.slice(0, CAT_FROM), ...siblings, ...nearest])].slice(0, POOL_MAX);
  }
  const { INPUT_HELP, inputsOf } = await import("./quantities.js");
  const inputs = opts.quantities ? pool.map(inputsOf) : [];
  const list = pool.map((i, k) => `${k}: ${label(i)}${inputs[k]?.length ? ` [inputs: ${inputs[k].map((n) => `${n} = ${INPUT_HELP[n]}`).join("; ")}]` : ""}`).join("\n");
  const key = createHash("sha1").update(`${opts.quantities ? "q" : ""}\n${question}\n${list}`).digest("hex");
  let hit = recent.get(key);
  if (!hit || Date.now() - hit.at > RECENT_MS) {
    const { routingFor } = await import("../llm/pin.js");
    const r = routingFor(MODEL);
    let j: any;
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL, temperature: 0, max_tokens: 400, response_format: { type: "json_object" }, provider: r.provider, ...(r.seed !== undefined ? { seed: r.seed } : {}), reasoning: { enabled: false },
          messages: [
            { role: "system", content: `Which of the business's items is what the customer's message asks for or needs for the job it describes - that product or service itself, not a related or neighbouring one? Several only when each one is that. None when nothing is. Answer JSON: {"ids": [<item id>, ...]} (at most ${limit}, best first).${opts.quantities ? ` Also, for each item you give that lists inputs, the value of each input the customer's latest message states or that follows directly from it (e.g. "Saturday and Sunday" = 48 hours, "4x5 m" = 20 m²) - leave out any the customer did not give, never assume a typical value, and leave out an input when the customer's quantity is of another kind (an area or a length for an item counted in pieces, buckets or bags: how many cover it is not known): "quantities": [{"id": <item id>, "input": "<input name>", "value": <number>}].` : ""}` },
            { role: "user", content: `Customer: ${question}\n\nItems:\n${list}` },
          ],
        }),
      });
      const c = String(((await res.json()) as any)?.choices?.[0]?.message?.content || "");
      j = firstJson(c);
    } catch (e) { console.warn(`[items] no answer: ${(e as Error).message}`); return null; }
    const ids = (Array.isArray(j?.ids) ? j.ids : []).filter((k: unknown) => Number.isInteger(k) && pool[k as number]) as number[];
    const q = (Array.isArray(j?.quantities) ? j.quantities : []).filter((x: any) => Number.isInteger(x?.id) && ids.includes(x.id) && inputs[x.id]?.includes(x.input) && typeof x.value === "number" && x.value > 0);
    hit = { at: Date.now(), ids: [...new Set(ids)], q };
    recent.set(key, hit);
    if (recent.size > 5000) recent.delete(recent.keys().next().value!);
    (await import("../llm/decision-log.js")).logDecision("items", MODEL, { question: question.slice(0, 1500), items: pool.map((i) => i.name.slice(0, 80)) }, { ids: hit.ids, quantities: q }, opts.tenant || "");
  }
  const given = new Map<OfferItem, Record<string, number>>();
  for (const x of hit.q) given.set(pool[x.id], { ...(given.get(pool[x.id]) || {}), [x.input]: x.value });
  return { items: hit.ids.slice(0, limit).map((k) => pool[k]), given };
}

/** The items the message is about, best first (at most `limit`); null when they could not be judged. */
export async function matchOfferItems(question: string, items: OfferItem[], limit = 8, tenant?: string): Promise<OfferItem[] | null> {
  return (await matchItems(question, items, { limit, tenant }))?.items ?? null;
}

/** Like matchOfferItems, [] when they could not be judged. */
export async function findOfferItems(question: string, items: OfferItem[], limit = 8, tenant?: string): Promise<OfferItem[]> {
  return (await matchOfferItems(question, items, limit, tenant)) ?? [];
}
