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
- {"rule":"optional","input":"<name>","price":<rule>}   an add-on the customer may choose (input answered yes/no), e.g. breakfast
- {"rule":"either","options":[rules]}   several prices where the text does NOT say which applies (e.g. "50/80 zł per person" without the condition) - never guess
- {"rule":"on_request"}
Use input names in English, short and concrete ("guests", "kg", "km", "hours", "hair length", "package", "m2").
Only prices written in the text - never invent or estimate. Weekday/day-of-week differences: a variant on "day".
Every input you declare must be used in the price rule, and every input the rule uses must be declared.
"quote" = the exact sentence(s) of the text that state these prices, copied word for word.
Return JSON {"recipes":[{"item":"<name as on the page>","quote":"<exact sentence(s)>","inputs":[{"name":"...","type":"number"|"choice","options":[...]?}],"price":<rule>,"note":"<one short sentence of conditions>"?}]}`;

const RULES = new Set(["fixed", "per", "rates", "variant", "tiers", "range", "sum", "cheapest", "extra", "optional", "either", "on_request"]);
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
    case "optional": return typeof r.input === "string" && !!r.input && validRule(r.price, depth + 1);
    case "either": return Array.isArray(r.options) && r.options.length > 1 && r.options.every((p: any) => validRule(p, depth + 1));
    case "on_request": return true;
  }
  return false;
}

const norm = (t: string) => t.toLowerCase().replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

/** Inputs a rule uses. */
function usedInputs(r: any, out = new Set<string>()): Set<string> {
  if (!r || typeof r !== "object") return out;
  if (typeof r.input === "string") out.add(r.input);
  if (r.rule === "range" && typeof r.per === "string") out.add(r.per);
  for (const v of Object.values(r)) if (v && typeof v === "object") (Array.isArray(v) ? v : Object.values(v)).forEach((x: any) => usedInputs(x, out));
  return out;
}
/** Structure checks only (code never reads the page): declared inputs are exactly the ones the rule uses. */
function consistent(x: any): string | null {
  const declared = new Set<string>((x.inputs || []).map((i: any) => String(i.name))), used = usedInputs(x.price);
  for (const d of declared) if (!used.has(d)) return `input "${d}" declared but not used`;
  for (const u of used) if (!declared.has(u)) return `input "${u}" used but not declared`;
  return null;
}

export interface ExtractedRecipe extends Recipe { item: string; quote?: string }

export async function readOnce(model: string, text: string, items?: string[]): Promise<{ recipes: (ExtractedRecipe & { id?: number })[]; rejected: string[] }> {
  const { routingFor } = await import("../llm/pin.js");
  const r = routingFor(model);
  let j: any = null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal: AbortSignal.timeout(90_000), headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 4000, response_format: { type: "json_object" }, provider: r.provider, ...(r.seed !== undefined ? { seed: r.seed } : {}), reasoning: { enabled: false }, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: items?.length ? `${text}\n\n---\nWrite one recipe for each of these items and give its number as "id": ${JSON.stringify(items.map((name, id) => ({ id, item: name })))}` : text }] }) });
    const c = String(((await res.json()) as any)?.choices?.[0]?.message?.content || "");
    j = JSON.parse(c.slice(c.indexOf("{"), c.lastIndexOf("}") + 1) || "null");
  } catch { return { recipes: [], rejected: ["no reading"] }; }
  const rejected: string[] = [];
  const recipes = (Array.isArray(j?.recipes) ? j.recipes : []).flatMap((x: any) => {
    if (typeof x?.item !== "string" || !validRule(x.price)) { rejected.push(`${x?.item}: invalid rule`); return []; }
    const why = consistent(x);
    if (why) { rejected.push(`${x.item}: ${why}`); return []; }
    const inputs = (Array.isArray(x.inputs) ? x.inputs : []).filter((i: any) => typeof i?.name === "string").map((i: any) => ({ name: i.name, type: i.type === "choice" ? "choice" : "number", ...(Array.isArray(i.options) ? { options: i.options.map(String) } : {}) }));
    return [{ item: x.item.slice(0, 200), ...(Number.isInteger(x.id) ? { id: x.id } : {}), inputs, price: x.price, ...(typeof x.quote === "string" ? { quote: String(x.quote).slice(0, 600) } : {}), ...(typeof x.note === "string" ? { note: x.note.slice(0, 300) } : {}), currency: "PLN" } as ExtractedRecipe & { id?: number }];
  });
  return { recipes, rejected };
}

/** Two recipes price every combination of inputs the same (a grid of typical values). */
function samePricing(a: ExtractedRecipe, b: ExtractedRecipe): boolean {
  const { evaluate } = recipeModule!;
  const names = [...new Set([...a.inputs, ...b.inputs].map((i) => i.name))];
  if (names.length > 4) return JSON.stringify(a.price) === JSON.stringify(b.price);
  const opts = (n: string) => { const o = [...a.inputs, ...b.inputs].find((i) => i.name === n && i.options?.length)?.options; return o && o.length ? [...o, "yes", "no"] : [1, 7, 30, 90, 150, "yes", "no"]; };
  let grid: Record<string, any>[] = [{}];
  for (const n of names) grid = grid.flatMap((g) => opts(n).map((v) => ({ ...g, [n]: v })));
  return grid.slice(0, 400).every((g) => JSON.stringify(evaluate(a.price, g)) === JSON.stringify(evaluate(b.price, g)));
}
let recipeModule: typeof import("./recipe.js") | null = null;

export async function extractRecipes(pageText: string): Promise<ExtractedRecipe[]> {
  const text = pageText.slice(0, 12000);
  // Two independent readings (different models); only recipes both read the same way are kept -
  // a misreading (Sosnowy Dwór rooms: 50 + 30 + 15 per guest) rarely happens twice the same way.
  const A = MODEL(), B = process.env.RECIPE_MODEL_2 || "anthropic/claude-haiku-5.5";
  const key = `decisions/recipes/${createHash("sha1").update(`v4\n${A}\n${B}\n${text}`).digest("hex")}.json`;
  const { downloadFromR2, uploadToR2 } = await import("../storage/r2.js");
  const stored = await downloadFromR2(key).then((buf) => (buf ? JSON.parse(buf.toString("utf-8")) : null)).catch(() => null);
  if (Array.isArray(stored)) { lastReport = null; return stored; }
  recipeModule ||= await import("./recipe.js");
  // The second reading gets the first one's items, so both price the same things (one reading wrote the
  // guest tiers as one item, the other as four - they never paired up).
  const ra = await readOnce(A, text);
  const rb = ra.recipes.length ? await readOnce(B, text, ra.recipes.map((r) => r.item)) : { recipes: [], rejected: [] as string[] };
  // Paired by id (structure), compared by evaluating both on a grid of inputs (structure -> structure, code).
  const byId = new Map(rb.recipes.filter((r) => r.id !== undefined).map((r) => [r.id!, r]));
  const agreed: ExtractedRecipe[] = [], disagreed: string[] = [];
  ra.recipes.forEach((r, k) => {
    const other = byId.get(k);
    if (other && samePricing(r, other)) agreed.push(r); else disagreed.push(r.item);
  });
  (await import("../llm/decision-log.js")).logDecision("recipes", `${A}+${B}`, { text: text.slice(0, 4000) }, { agreed, disagreed, rejectedA: ra.rejected, rejectedB: rb.rejected });
  if (ra.recipes.length || rb.recipes.length) await uploadToR2(key, JSON.stringify(agreed), "application/json").catch(() => {});
  lastReport = { agreed: agreed.length, disagreed, rejectedA: ra.rejected, rejectedB: rb.rejected };
  return agreed;
}
/** What the last extraction kept and dropped (evaluation and logs). */
export let lastReport: { agreed: number; disagreed: string[]; rejectedA: string[]; rejectedB: string[] } | null = null;
