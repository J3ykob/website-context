/**
 * Prices for the customer's own quantities (docs/noise-plan.md #3, #4). The reply model did this
 * arithmetic itself and chose differently run to run - 30 h of a pump at 30 x 28 zł instead of two days at
 * 140 zł (chain C14, C19). Now, by the owner's rule (text -> structure by a model, structure -> structure
 * by code, structure -> text by a model):
 *   - one pinned model call reads the quantities the customer gave for each matched item's recipe inputs;
 *   - code prices them with the item's recipe (src/offer/recipe.ts: the cheapest combination of rates);
 *   - the reply gets the results as facts and only words them.
 */
import type { OfferItem } from "./store.js";
import { recipeFromFields, evaluate, type Recipe } from "./recipe.js";

const MODEL = "anthropic/claude-haiku-5.5";

// How each input a recipe from fields can have is described to the model (recipe.ts INPUT_OF / rates).
const INPUT_HELP: Record<string, string> = {
  hours: "duration of use in hours (a day / doba = 24 h, a week = 168 h)",
  pieces: "number of pieces", kg: "weight in kg", tonnes: "weight in tonnes", m2: "area in m²", m3: "volume in m³",
  metres: "length in metres", bags: "number of bags", pallets: "number of pallets", litres: "litres", people: "number of people",
  sets: "number of sets", visits: "number of visits",
};

export interface CustomerPrice { item: OfferItem; given: Record<string, number>; amount: number; combined: boolean }

/** The matched items priced for the quantities the customer gave; [] when none given or no reading. */
export async function priceForCustomer(conversation: string, items: OfferItem[], tenant = ""): Promise<CustomerPrice[]> {
  const priced = items.map((item) => ({ item, recipe: recipeFromFields(item) }))
    .filter((x): x is { item: OfferItem; recipe: Recipe } => !!x.recipe && x.recipe.inputs.length > 0 && x.recipe.inputs.every((i) => i.name in INPUT_HELP));
  if (!priced.length || !process.env.OPENROUTER_API_KEY) return [];
  const list = priced.map((x, id) => ({ id, item: x.item.name, inputs: x.recipe.inputs.map((i) => ({ name: i.name, means: INPUT_HELP[i.name] })) }));
  const { routingFor } = await import("../llm/pin.js");
  const r = routingFor(MODEL);
  let j: any = null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL, temperature: 0, max_tokens: 600, response_format: { type: "json_object" }, provider: r.provider, ...(r.seed !== undefined ? { seed: r.seed } : {}), reasoning: { enabled: false },
        messages: [
          { role: "system", content: `For each item, the value of each input that the customer's LATEST request states or that follows directly from it (e.g. "Saturday and Sunday" = 48 hours, "4x5 m" = 20 m²). Leave out an input the customer did not give - never assume or pick a typical value. Answer JSON: {"quantities": [{"id": <item id>, "input": "<input name>", "value": <number>}]}.` },
          { role: "user", content: `Conversation:\n${conversation}\n\nItems:\n${JSON.stringify(list)}` },
        ],
      }),
    });
    const c = String(((await res.json()) as any)?.choices?.[0]?.message?.content || "");
    j = JSON.parse(c.slice(c.indexOf("{"), c.lastIndexOf("}") + 1) || "null");
  } catch { return []; }
  const given = new Map<number, Record<string, number>>();
  for (const q of Array.isArray(j?.quantities) ? j.quantities : []) {
    if (!Number.isInteger(q?.id) || !priced[q.id] || typeof q.value !== "number" || !(q.value > 0)) continue;
    if (!priced[q.id].recipe.inputs.some((i) => i.name === q.input)) continue;
    given.set(q.id, { ...(given.get(q.id) || {}), [q.input]: q.value });
  }
  const out: CustomerPrice[] = [];
  for (const [id, g] of given) {
    const { item, recipe } = priced[id];
    const res = evaluate(recipe.price, g);
    if (res.kind === "price") out.push({ item, given: g, amount: res.amount, combined: recipe.price.rule === "rates" && recipe.price.rates.length > 1 });
  }
  (await import("../llm/decision-log.js")).logDecision("quantities", MODEL, { conversation: conversation.slice(-1500), items: list }, { quantities: j?.quantities ?? null }, tenant);
  return out;
}

/** A computed price as a fact line for the reply. */
export function customerPriceLine(p: CustomerPrice, currency = "zł"): string {
  const what = Object.entries(p.given).map(([k, v]) => `${k} ${v}`).join(", ");
  return `${p.item.name}, for the customer's ${what}: ${p.amount} ${currency}${p.combined ? " (computed from our rates - the cheapest combination of the hourly / daily / weekly rates)" : " (computed from our price list)"}`;
}
