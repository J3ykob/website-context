/**
 * Price recipes (docs/noise-plan.md): how ONE offer item turns a customer's details into a price. No
 * universal schema - each recipe names its own inputs (hair length, guests, wall area, nights, volume,
 * duration...) and combines them with a few general rules. Evaluated by code, so the same inputs always
 * give the same result; the model only fills the inputs from the conversation and words the answer.
 *
 * Result for any recipe, comparable across businesses and industries:
 *   { kind: "price", amount }            a single price
 *   { kind: "range", min, max }          a range (or "from" with max = null)
 *   { kind: "needs", inputs }            which inputs are still missing
 *   { kind: "on_request" }               no price without the business (quote, visit, design)
 */

export type InputValue = number | string;
export interface RecipeInput { name: string; label?: string; type: "number" | "choice"; unit?: string; options?: string[] }

export type Rule =
  | { rule: "fixed"; price: number }                                                     // a haircut, a bouquet
  | { rule: "per"; input: string; price: number; min?: number; minCharge?: number }     // per m², per guest, per kg (min weight)
  | { rule: "rates"; input: string; rates: { per: number; price: number }[]; minUnits?: number } // duration in base units (e.g. hours): best combination of per-hour / per-day / per-week
  | { rule: "variant"; input: string; prices: Record<string, number | Rule> }            // hair length short/long, menu standard/premium
  | { rule: "tiers"; input: string; tiers: { from: number; to?: number; price: number }[]; per?: boolean } // per guest priced by guest count; per=false: the tier price is the total
  | { rule: "range"; min: number; max: number | null; per?: string }                    // "70-110 zł/m²" or "from 3500"
  | { rule: "sum"; parts: Rule[] }                                                       // components that add up (scaffolding elements, menu + service)
  | { rule: "cheapest"; options: Rule[] }                                                // alternatives: the cheapest that can be priced
  | { rule: "extra"; input: string; free?: number; price: number }                      // travel: free up to N km, then per km
  | { rule: "on_request" };

export interface Recipe { inputs: RecipeInput[]; price: Rule; currency?: string; note?: string }

export type PriceResult =
  | { kind: "price"; amount: number }
  | { kind: "range"; min: number; max: number | null }
  | { kind: "needs"; inputs: string[] }
  | { kind: "on_request" };

const round = (n: number) => Math.round(n * 100) / 100;

export function evaluate(rule: Rule, given: Record<string, InputValue | undefined>): PriceResult {
  const num = (name: string): number | undefined => { const v = given[name]; const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN; return Number.isFinite(n) ? n : undefined; };
  const need = (...names: string[]): PriceResult => ({ kind: "needs", inputs: names });
  switch (rule.rule) {
    case "fixed": return { kind: "price", amount: round(rule.price) };
    case "on_request": return { kind: "on_request" };
    case "range": {
      if (!rule.per) return { kind: "range", min: rule.min, max: rule.max };
      const q = num(rule.per);
      return q === undefined ? need(rule.per) : { kind: "range", min: round(rule.min * q), max: rule.max === null ? null : round(rule.max * q) };
    }
    case "per": {
      const q = num(rule.input);
      if (q === undefined) return need(rule.input);
      const amount = Math.max(q, rule.min ?? 0) * rule.price;
      return { kind: "price", amount: round(Math.max(amount, rule.minCharge ?? 0)) };
    }
    case "extra": {
      const q = num(rule.input);
      if (q === undefined) return need(rule.input);
      return { kind: "price", amount: round(Math.max(0, q - (rule.free ?? 0)) * rule.price) };
    }
    case "rates": {
      const q = num(rule.input);
      if (q === undefined) return need(rule.input);
      const units = Math.max(q, rule.minUnits ?? 0);
      // Cheapest way to cover `units` with the given period rates (e.g. 30 h with per-hour 28 / per-day 140
      // -> 2 days = 280). Small knapsack over the periods, units rounded up to the smallest period.
      const rates = [...rule.rates].filter((r) => r.per > 0 && r.price >= 0).sort((a, b) => a.per - b.per);
      if (!rates.length) return { kind: "on_request" };
      const step = rates[0].per, n = Math.ceil(units / step - 1e-9);
      const best = new Array(n + 1).fill(Infinity); best[0] = 0;
      for (let k = 1; k <= n; k++) for (const r of rates) { const len = Math.round(r.per / step); best[k] = Math.min(best[k], best[Math.max(0, k - len)] + r.price); }
      return { kind: "price", amount: round(best[n]) };
    }
    case "variant": {
      const v = given[rule.input];
      if (v === undefined || v === "") return need(rule.input);
      const hit = Object.entries(rule.prices).find(([k]) => k.toLowerCase() === String(v).toLowerCase());
      if (!hit) return need(rule.input);
      return typeof hit[1] === "number" ? { kind: "price", amount: round(hit[1]) } : evaluate(hit[1], given);
    }
    case "tiers": {
      const q = num(rule.input);
      if (q === undefined) return need(rule.input);
      const t = rule.tiers.find((x) => q >= x.from && (x.to === undefined || q <= x.to));
      if (!t) return { kind: "on_request" };
      return { kind: "price", amount: round(rule.per === false ? t.price : t.price * q) };
    }
    case "sum": {
      const rs = rule.parts.map((p) => evaluate(p, given));
      const missing = [...new Set(rs.flatMap((r) => (r.kind === "needs" ? r.inputs : [])))];
      if (missing.length) return need(...missing);
      if (rs.some((r) => r.kind === "on_request")) return { kind: "on_request" };
      if (rs.every((r) => r.kind === "price")) return { kind: "price", amount: round(rs.reduce((s, r) => s + (r as { amount: number }).amount, 0)) };
      const lo = rs.reduce((s, r) => s + (r.kind === "price" ? r.amount : (r as { min: number }).min), 0);
      const hi = rs.some((r) => r.kind === "range" && r.max === null) ? null : rs.reduce((s, r) => s + (r.kind === "price" ? r.amount : (r as { max: number }).max), 0);
      return { kind: "range", min: round(lo), max: hi === null ? null : round(hi) };
    }
    case "cheapest": {
      const rs = rule.options.map((o) => evaluate(o, given));
      const priced = rs.filter((r): r is { kind: "price"; amount: number } => r.kind === "price");
      if (priced.length) return { kind: "price", amount: Math.min(...priced.map((r) => r.amount)) };
      const missing = [...new Set(rs.flatMap((r) => (r.kind === "needs" ? r.inputs : [])))];
      return missing.length ? need(...missing) : rs.find((r) => r.kind === "range") || { kind: "on_request" };
    }
  }
}

/** The inputs a recipe could use that the customer has not given (to ask for, or to fill from the conversation). */
export function missingInputs(recipe: Recipe, given: Record<string, InputValue | undefined>): string[] {
  const r = evaluate(recipe.price, given);
  return r.kind === "needs" ? r.inputs : [];
}

// ── From the fields an offer item already has (no model) ──
// Period units in hours, so rental rates per hour / day / week / month combine into the cheapest cover.
const PERIOD_HOURS: Record<string, number> = { godzina: 1, doba: 24, tydzien: 168, miesiac: 720 };
const INPUT_OF: Record<string, string> = { szt: "pieces", kg: "kg", t: "tonnes", m2: "m2", m3: "m3", mb: "metres", worek: "bags", paleta: "pallets", litr: "litres", osoba: "people", komplet: "sets", wizyta: "visits" };

interface FieldsLike { fields: Record<string, string | undefined>; price_value: number | null; price_max: number | null; currency?: string; components?: { label: string; price_type: string; price_value: number | null; price_max: number | null; unit: string; quantity_from: "fixed" | "customer"; quantity_label: string; combine: "sum" | "alternative" }[] }

function ruleOf(priceType: string | undefined, value: number | null, max: number | null, unit: string | undefined, qtyLabel?: string): Rule | null {
  const u = unit && unit !== "unknown" ? unit : "";
  if (priceType === "on_request" || priceType === "not_listed") return { rule: "on_request" };
  if (priceType === "free" || priceType === "included") return { rule: "fixed", price: 0 };
  if (value === null) return null;
  const input = qtyLabel || (u in PERIOD_HOURS ? "hours" : INPUT_OF[u] || "");
  if (priceType === "range") return { rule: "range", min: value, max, ...(input && u && !["usluga", "projekt"].includes(u) ? { per: input } : {}) };
  if (priceType === "from") return { rule: "range", min: value, max: null };
  if (u in PERIOD_HOURS) return { rule: "rates", input: "hours", rates: [{ per: PERIOD_HOURS[u], price: value }] };
  if (priceType === "per_unit" && input) return { rule: "per", input, price: value };
  if (priceType === "fixed" && input && u && !["usluga", "projekt", "wizyta"].includes(u)) return { rule: "per", input, price: value };
  return { rule: "fixed", price: value };
}

/** A recipe from an offer item's existing fields; null when they say too little (no price, no type). */
export function recipeFromFields(item: FieldsLike): Recipe | null {
  const comps = item.components || [];
  let price: Rule | null;
  if (comps.length) {
    const parts = comps.map((c) => ruleOf(c.price_type, c.price_value, c.price_max, c.unit, c.quantity_from === "customer" ? c.quantity_label : undefined));
    if (parts.some((p) => p === null)) return null;
    // Alternative period rates of one rental (per hour OR per day) are one "rates" rule (cheapest cover).
    const allRates = parts.every((p) => p!.rule === "rates");
    price = allRates ? { rule: "rates", input: "hours", rates: parts.flatMap((p) => (p as Extract<Rule, { rule: "rates" }>).rates) }
      : comps.every((c) => c.combine === "alternative") ? { rule: "cheapest", options: parts as Rule[] } : { rule: "sum", parts: parts as Rule[] };
  } else {
    // A product sold by the piece: a fixed price is per piece (3 drills = 3 x the price).
    const unit = item.fields.unit && item.fields.unit !== "unknown" ? item.fields.unit : item.fields.kind === "product" && item.fields.price_type !== "range" && item.fields.price_type !== "from" ? "szt" : item.fields.unit;
    price = ruleOf(item.fields.price_type, item.price_value, item.price_max, unit);
  }
  // No price stated at all: the honest answer is to ask the business.
  if (!price && item.price_value === null) price = { rule: "on_request" };
  if (!price) return null;
  const inputs = new Map<string, RecipeInput>();
  const walk = (r: Rule): void => {
    if ("input" in r && r.input) inputs.set(r.input, { name: r.input, type: r.rule === "variant" ? "choice" : "number" });
    if (r.rule === "range" && r.per) inputs.set(r.per, { name: r.per, type: "number" });
    if (r.rule === "sum") r.parts.forEach(walk);
    if (r.rule === "cheapest") r.options.forEach(walk);
  };
  walk(price);
  return { inputs: [...inputs.values()], price, currency: item.currency || "PLN" };
}
