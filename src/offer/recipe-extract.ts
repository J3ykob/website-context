/**
 * Price recipes read from an offer page's own text (when an item's fields can't express its pricing:
 * cake per kg with a minimum weight, venue price per guest by guest count, travel per km beyond a free
 * radius, photographer packages with extra hours). One model call per page, pinned provider, temperature
 * 0; every recipe is validated by code (known rules, numbers, inputs it uses) and stored per page text, so
 * the same page always yields the same recipes. Anything the model can't express stays on request.
 */
import { createHash } from "crypto";
import type { Recipe, Rule } from "./recipe.js";

const MODEL = () => process.env.RECIPE_MODEL || "deepseek/deepseek-v4.1-flash";

const SYSTEM = `You read a business's price information and write, for each product or service it prices, a PRICE RECIPE in JSON.
A recipe names the customer's details it needs (inputs) and combines them with these rules only:
- {"rule":"fixed","price":N}
- {"rule":"per","input":"<name>","price":N,"min":M?,"minCharge":C?}   price per unit of an input (per kg, per guest, per m2); min = minimum quantity
- {"rule":"rates","input":"hours","rates":[{"per":H,"price":N},...]}   rental/period rates; per = length in HOURS (hour 1, day 24, week 168)
- {"rule":"variant","input":"<name>","prices":{"<option>":N or rule,...}}   price by a choice (hair length, package, menu)
- {"rule":"tiers","input":"<name>","tiers":[{"from":A,"to":B?,"price":N},...],"per":true|false}   price by a number band (per guest by guest count; per=false: the tier price is the total)
- {"rule":"range","min":N,"max":M or null,"per":"<input>"?}   "from N" = max null
- {"rule":"sum","parts":[rules]}   parts that add up (service + travel)
- {"rule":"cheapest","options":[rules]}   alternatives, the cheapest applies
- {"rule":"extra","input":"<name>","free":F?,"price":N}   charge per unit beyond a free amount (travel per km beyond F km)
- {"rule":"on_request"}
Use input names in English, short and concrete ("guests", "kg", "km", "hours", "hair length", "package", "m2").
Only prices written in the text - never invent or estimate. Weekday/day-of-week differences: a variant on "day".
Return JSON {"recipes":[{"item":"<name as on the page>","inputs":[{"name":"...","type":"number"|"choice","options":[...]?}],"price":<rule>,"note":"<one short sentence of conditions>"?}]}`;

const RULES = new Set(["fixed", "per", "rates", "variant", "tiers", "range", "sum", "cheapest", "extra", "on_request"]);
const isNum = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;

/** A recipe rule is well-formed (only known rules, numbers where numbers belong, inputs named). */
export function validRule(r: any, depth = 0): r is Rule {
  if (!r || typeof r !== "object" || !RULES.has(r.rule) || depth > 4) return false;
  switch (r.rule) {
    case "fixed": return isNum(r.price);
    case "per": return typeof r.input === "string" && !!r.input && isNum(r.price) && (r.min === undefined || isNum(r.min)) && (r.minCharge === undefined || isNum(r.minCharge));
    case "rates": return r.input === "hours" && Array.isArray(r.rates) && r.rates.length > 0 && r.rates.every((x: any) => isNum(x?.per) && x.per > 0 && isNum(x?.price));
    case "variant": return typeof r.input === "string" && r.prices && typeof r.prices === "object" && Object.keys(r.prices).length > 0 && Object.values(r.prices).every((v) => isNum(v) || validRule(v, depth + 1));
    case "tiers": return typeof r.input === "string" && Array.isArray(r.tiers) && r.tiers.length > 0 && r.tiers.every((t: any) => isNum(t?.from) && isNum(t?.price) && (t.to === undefined || isNum(t.to)));
    case "range": return isNum(r.min) && (r.max === null || isNum(r.max)) && (r.per === undefined || typeof r.per === "string");
    case "sum": return Array.isArray(r.parts) && r.parts.length > 0 && r.parts.every((p: any) => validRule(p, depth + 1));
    case "cheapest": return Array.isArray(r.options) && r.options.length > 0 && r.options.every((p: any) => validRule(p, depth + 1));
    case "extra": return typeof r.input === "string" && isNum(r.price) && (r.free === undefined || isNum(r.free));
    case "on_request": return true;
  }
  return false;
}

/** Every number in a recipe appears in the page text (no invented prices). */
function numbersFromText(rule: Rule, text: string): boolean {
  const nums: number[] = [];
  const walk = (r: any) => { for (const [k, v] of Object.entries(r)) { if (k === "per" && r.rule === "rates") continue; if (typeof v === "number" && !["from", "to", "free", "min"].includes(k)) nums.push(v); else if (v && typeof v === "object") Array.isArray(v) ? v.forEach((x) => typeof x === "object" && walk(x)) : walk(v); } };
  walk(rule);
  const flat = text.replace(/\s+/g, "").replace(/,/g, ".");
  return nums.every((n) => n === 0 || flat.includes(String(n)) || flat.includes(n.toFixed(2)) || flat.includes(String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "")));
}

export interface ExtractedRecipe extends Recipe { item: string }

export async function extractRecipes(pageText: string): Promise<ExtractedRecipe[]> {
  const text = pageText.slice(0, 12000);
  const key = `decisions/recipes/${createHash("sha1").update(`v1\n${MODEL()}\n${text}`).digest("hex")}.json`;
  const { downloadFromR2, uploadToR2 } = await import("../storage/r2.js");
  const stored = await downloadFromR2(key).then((b) => (b ? JSON.parse(b.toString("utf-8")) : null)).catch(() => null);
  if (Array.isArray(stored)) return stored;
  const { routingFor } = await import("../llm/pin.js");
  const r = routingFor(MODEL());
  let j: any = null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal: AbortSignal.timeout(90_000), headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL(), temperature: 0, max_tokens: 4000, response_format: { type: "json_object" }, provider: r.provider, ...(r.seed !== undefined ? { seed: r.seed } : {}), reasoning: { enabled: false }, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }] }) });
    j = JSON.parse(((await res.json()) as any)?.choices?.[0]?.message?.content || "null");
  } catch { return []; }
  const out: ExtractedRecipe[] = (Array.isArray(j?.recipes) ? j.recipes : []).flatMap((x: any) => {
    if (typeof x?.item !== "string" || !validRule(x.price) || !numbersFromText(x.price, text)) return [];
    const inputs = (Array.isArray(x.inputs) ? x.inputs : []).filter((i: any) => typeof i?.name === "string").map((i: any) => ({ name: i.name, type: i.type === "choice" ? "choice" : "number", ...(Array.isArray(i.options) ? { options: i.options.map(String) } : {}) }));
    return [{ item: x.item.slice(0, 200), inputs, price: x.price, ...(typeof x.note === "string" ? { note: x.note.slice(0, 300) } : {}), currency: "PLN" }];
  });
  (await import("../llm/decision-log.js")).logDecision("recipes", MODEL(), { text: text.slice(0, 4000) }, out);
  await uploadToR2(key, JSON.stringify(out), "application/json").catch(() => {});
  return out;
}
