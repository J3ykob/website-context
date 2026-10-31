/**
 * Prices for the customer's own quantities (docs/noise-plan.md #3, #4). The reply model did this
 * arithmetic itself and chose differently run to run - 30 h of a pump at 30 x 28 zł instead of two days at
 * 140 zł (chain C14, C19). Now, by the owner's rule (text -> structure by a model, structure -> structure
 * by code, structure -> text by a model):
 *   - the item matcher (src/offer/search.ts) reads the quantities the customer gave for each picked item's
 *     recipe inputs, in the same call that picks the items;
 *   - code prices them here with the item's recipe (src/offer/recipe.ts: the cheapest combination of rates);
 *   - the reply gets the results as facts and only words them.
 */
import type { OfferItem } from "./store.js";
import { recipeFromFields, evaluate } from "./recipe.js";

// How each input a recipe from fields can have is described to the model (recipe.ts INPUT_OF / rates).
export const INPUT_HELP: Record<string, string> = {
  hours: "duration of use in hours (a day / doba = 24 h, a week = 168 h)",
  pieces: "number of pieces", kg: "weight in kg", tonnes: "weight in tonnes", m2: "area in m²", m3: "volume in m³",
  metres: "length in metres", bags: "number of bags", pallets: "number of pallets", litres: "litres", people: "number of people",
  sets: "number of sets", visits: "number of visits", quantity: "the amount the price depends on (as the item counts it)",
};

/** The price inputs an item's recipe needs, when they are all ones we can describe; [] otherwise. */
export function inputsOf(item: OfferItem): string[] {
  const r = recipeFromFields(item);
  if (!r || !r.inputs.length || !r.inputs.every((i) => i.name in INPUT_HELP)) return [];
  return r.inputs.map((i) => i.name);
}

export interface CustomerPrice { item: OfferItem; given: Record<string, number>; amount: number; combined: boolean }

/** The items priced for the quantities read from the customer (only those that come to a single price). */
export function priceGiven(given: Map<OfferItem, Record<string, number>>): CustomerPrice[] {
  const out: CustomerPrice[] = [];
  for (const [item, g] of given) {
    const recipe = recipeFromFields(item);
    if (!recipe) continue;
    const res = evaluate(recipe.price, g);
    if (res.kind === "price") out.push({ item, given: g, amount: res.amount, combined: recipe.price.rule === "rates" && recipe.price.rates.length > 1 });
  }
  return out;
}

/** A computed price as a fact line for the reply. */
export function customerPriceLine(p: CustomerPrice, currency = "zł"): string {
  const what = Object.entries(p.given).map(([k, v]) => `${k} ${v}`).join(", ");
  return `${p.item.name}, for the customer's ${what}: ${p.amount} ${currency}${p.combined ? " (computed from our rates - the cheapest combination of the hourly / daily / weekly rates)" : " (computed from our price list)"}`;
}
