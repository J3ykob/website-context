/**
 * Prices for the customer's own quantities (docs/noise-plan.md #3, #4). The reply model did this
 * arithmetic itself and chose differently run to run - 30 h of a pump at 30 x 28 zł instead of two days at
 * 140 zł (chain C14, C19). Now, by the owner's rule (text -> structure by a model, structure -> structure
 * by code, structure -> text by a model):
 *   - the item matcher (src/offer/search.ts) reads the quantities the customer gave for each picked item's
 *     recipe inputs, in a call of its own after the pick (asked in the pick's call, they were dropped - empro-1) - a
 *     number, a period (its start and end) or an amount with the conversion the item states (src/pricing/quantity.ts);
 *   - code counts them (periods, conversions) and prices them here with the item's recipe (src/offer/recipe.ts: the
 *     cheapest combination of rates) - for each reading when a period lacks a time;
 *   - the reply gets the results as facts and only words them.
 */
import type { OfferItem } from "./store.js";
import { recipeFromFields, evaluate } from "./recipe.js";
import { readingsOf, describeReading, type TimeUnit } from "../pricing/quantity.js";

// How each input a recipe from fields can have is described to the model (recipe.ts INPUT_OF / rates).
export const INPUT_HELP: Record<string, string> = {
  hours: "duration of use in hours (a day / doba = 24 h, a week = 168 h)",
  pieces: "number of pieces", kg: "weight in kg", tonnes: "weight in tonnes", m2: "area in m²", m3: "volume in m³",
  metres: "length in metres", bags: "number of bags", pallets: "number of pallets", litres: "litres", people: "number of people",
  sets: "number of sets", visits: "number of visits", quantity: "the amount the price depends on (as the item counts it)",
};
// The recipe input that counts time: recipe.ts turns every period rate (hour, doba, week, month) into hours.
const TIME_INPUT: Record<string, TimeUnit> = { hours: "hour" };

/** The price inputs an item's recipe needs, when they are all ones we can describe; [] otherwise. */
export function inputsOf(item: OfferItem): string[] {
  const r = recipeFromFields(item);
  if (!r || !r.inputs.length || !r.inputs.every((i) => i.name in INPUT_HELP)) return [];
  return r.inputs.map((i) => i.name);
}

/** One reading of the customer's quantities, priced: the values the recipe got, its price, what the reading assumes. */
export interface PricedReading { given: Record<string, number>; amount: number; what: string }
export interface CustomerPrice { item: OfferItem; readings: PricedReading[]; combined: boolean }

/**
 * The items priced for the quantities read from the customer - only those that come to a single price. `given`: the
 * values as the matcher read them (numbers, periods, conversions); a period without a time is priced for both of its
 * readings.
 */
export function priceGiven(given: Map<OfferItem, Record<string, unknown>>): CustomerPrice[] {
  const out: CustomerPrice[] = [];
  for (const [item, g] of given) {
    const recipe = recipeFromFields(item);
    if (!recipe) continue;
    const inputs = Object.entries(g).map(([name, v]) => ({ name, v, rs: readingsOf(v, TIME_INPUT[name]) }));
    const n = Math.max(1, ...inputs.map((x) => (x.rs?.length ? x.rs.length : 1)));
    const readings: PricedReading[] = [];
    for (let k = 0; k < n; k++) {
      const values: Record<string, number> = {}, what: string[] = [];
      for (const { name, v, rs } of inputs) {
        if (rs === null) { if (typeof v === "number" && Number.isFinite(v)) { values[name] = v; what.push(`${name} ${v}`); } continue; }
        if (!rs.length) continue;
        const r = rs[Math.min(k, rs.length - 1)];
        values[name] = r.value;
        what.push(describeReading(name, v, r, TIME_INPUT[name]));
      }
      const res = evaluate(recipe.price, values);
      if (res.kind !== "price") break;
      readings.push({ given: values, amount: res.amount, what: what.join(", ") });
    }
    if (readings.length && readings.length === n) out.push({ item, readings, combined: recipe.price.rule === "rates" && recipe.price.rates.length > 1 });
  }
  return out;
}

/** A computed price as a fact line for the reply. */
export function customerPriceLine(p: CustomerPrice, currency = "zł"): string {
  const how = p.combined ? "computed from our rates - the cheapest combination of the hourly / daily / weekly rates" : "computed from our price list";
  if (p.readings.length === 1) return `${p.item.name}, for the customer's ${p.readings[0].what}: ${p.readings[0].amount} ${currency} (${how})`;
  return `${p.item.name} (${how}; the customer gave no time, so both readings): ${p.readings.map((r) => `${r.amount} ${currency} for ${r.what}`).join("; or ")}`;
}

/** The prices an item lists itself (its own and its components'): amounts a reply may state as they are. */
export function listedAmounts(item: OfferItem): number[] {
  return [item.price_value, item.price_max, ...(item.components || []).flatMap((c) => [c.price_value, c.price_max])].filter((x): x is number => typeof x === "number" && Number.isFinite(x));
}
