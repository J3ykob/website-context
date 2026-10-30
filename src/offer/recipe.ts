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
