import { describe, it, expect } from "vitest";
import { evaluate, type Rule } from "../src/offer/recipe.js";

// Recipes from real offers in two unrelated industries (construction rental, weddings, a hair salon):
// the same few rules, each offer with its own inputs.
describe("price recipes", () => {
  it("rental: the cheapest combination of hourly / daily rates (sludge pump, 30 h -> 2 days)", () => {
    const pump: Rule = { rule: "rates", input: "hours", rates: [{ per: 1, price: 28 }, { per: 24, price: 140 }] };
    expect(evaluate(pump, { hours: 30 })).toEqual({ kind: "price", amount: 280 });
    expect(evaluate(pump, { hours: 5 })).toEqual({ kind: "price", amount: 140 });
    expect(evaluate(pump, { hours: 3 })).toEqual({ kind: "price", amount: 84 });
    expect(evaluate(pump, {})).toEqual({ kind: "needs", inputs: ["hours"] });
  });

  it("per unit with a minimum (wedding cake per kg, minimum 9 kg)", () => {
    const cake: Rule = { rule: "per", input: "kg", price: 140, min: 9 };
    expect(evaluate(cake, { kg: 12.5 })).toEqual({ kind: "price", amount: 1750 });
    expect(evaluate(cake, { kg: 6 })).toEqual({ kind: "price", amount: 1260 });
  });

  it("per guest priced by guest count (venue tiers: more guests, lower price per person)", () => {
    const venue: Rule = { rule: "tiers", input: "guests", tiers: [{ from: 40, to: 59, price: 245 }, { from: 60, to: 79, price: 225 }, { from: 80, to: 99, price: 205 }, { from: 100, price: 200 }] };
    expect(evaluate(venue, { guests: 120 })).toEqual({ kind: "price", amount: 24000 });
    expect(evaluate(venue, { guests: 70 })).toEqual({ kind: "price", amount: 15750 });
    expect(evaluate(venue, { guests: 20 })).toEqual({ kind: "on_request" });
  });

  it("variant (haircut by hair length) and packages (photographer)", () => {
    const cut: Rule = { rule: "variant", input: "hair length", prices: { short: 80, medium: 100, long: 130 } };
    expect(evaluate(cut, { "hair length": "long" })).toEqual({ kind: "price", amount: 130 });
    expect(evaluate(cut, {})).toEqual({ kind: "needs", inputs: ["hair length"] });
    const photo: Rule = { rule: "variant", input: "package", prices: { economy: { rule: "sum", parts: [{ rule: "fixed", price: 3500 }, { rule: "extra", input: "hours", free: 6, price: 500 }] }, standard: 5000 } };
    expect(evaluate(photo, { package: "economy", hours: 8 })).toEqual({ kind: "price", amount: 4500 });
    expect(evaluate(photo, { package: "standard" })).toEqual({ kind: "price", amount: 5000 });
  });

  it("sum with travel (make-up: service + km beyond 30 km free at 3 zł/km)", () => {
    const mk: Rule = { rule: "sum", parts: [{ rule: "fixed", price: 500 }, { rule: "extra", input: "km", free: 30, price: 3 }] };
    expect(evaluate(mk, { km: 50 })).toEqual({ kind: "price", amount: 560 });
    expect(evaluate(mk, {})).toEqual({ kind: "needs", inputs: ["km"] });
  });

  it("ranges stay ranges (render 70-110 zł/m² x 200 m²), on request stays on request (mural)", () => {
    expect(evaluate({ rule: "range", min: 70, max: 110, per: "m2" }, { m2: 200 })).toEqual({ kind: "range", min: 14000, max: 22000 });
    expect(evaluate({ rule: "sum", parts: [{ rule: "fixed", price: 100 }, { rule: "on_request" }] }, {})).toEqual({ kind: "on_request" });
  });

  it("alternatives: the cheapest that can be priced (trestles)", () => {
    const tr: Rule = { rule: "cheapest", options: [{ rule: "per", input: "pieces", price: 240 }, { rule: "per", input: "pieces", price: 350 }, { rule: "on_request" }] };
    expect(evaluate(tr, { pieces: 15 })).toEqual({ kind: "price", amount: 3600 });
  });
});

import { recipeFromFields } from "../src/offer/recipe.js";
describe("recipes from existing offer fields (no model)", () => {
  it("rental with hourly and daily alternatives -> cheapest cover", () => {
    const r = recipeFromFields({ fields: { price_type: "per_unit", unit: "godzina" }, price_value: 28, price_max: null, components: [
      { label: "godzina", price_type: "per_unit", price_value: 28, price_max: null, unit: "godzina", quantity_from: "customer", quantity_label: "", combine: "alternative" },
      { label: "doba", price_type: "per_unit", price_value: 140, price_max: null, unit: "doba", quantity_from: "customer", quantity_label: "", combine: "alternative" }] })!;
    expect(evaluate(r.price, { hours: 30 })).toEqual({ kind: "price", amount: 280 });
  });
  it("per m² range, fixed service, on request", () => {
    expect(evaluate(recipeFromFields({ fields: { price_type: "range", unit: "m2" }, price_value: 70, price_max: 110 })!.price, { m2: 200 })).toEqual({ kind: "range", min: 14000, max: 22000 });
    expect(evaluate(recipeFromFields({ fields: { price_type: "fixed", unit: "usluga" }, price_value: 350, price_max: null })!.price, {})).toEqual({ kind: "price", amount: 350 });
    expect(evaluate(recipeFromFields({ fields: { price_type: "on_request" }, price_value: null, price_max: null })!.price, {})).toEqual({ kind: "on_request" });
  });
});

describe("optional add-ons and unclear alternatives", () => {
  it("rooms: 50 or 80 zł per person (condition not stated) + optional breakfast 15 zł, or all rooms flat 1000 zł", () => {
    const rooms: Rule = { rule: "either", options: [
      { rule: "sum", parts: [{ rule: "either", options: [{ rule: "per", input: "people", price: 50 }, { rule: "per", input: "people", price: 80 }] }, { rule: "optional", input: "breakfast", price: { rule: "per", input: "people", price: 15 } }] },
      { rule: "fixed", price: 1000 }] };
    expect(evaluate(rooms, { people: 10, breakfast: "yes" })).toEqual({ kind: "range", min: 650, max: 1000 });
    expect(evaluate(rooms, { people: 10 })).toEqual({ kind: "needs", inputs: ["breakfast"] });
  });
});

import { choiceProblems } from "../src/projects/agent.js";
describe("agent choice check (wybor.json, structure only)", () => {
  const pump = { name: "Pompa do szlamu", fields: { price_type: "per_unit", unit: "godzina" }, price_value: 28, price_max: null, components: [
    { label: "godzina", price_type: "per_unit", price_value: 28, price_max: null, unit: "godzina", quantity_from: "customer" as const, quantity_label: "", combine: "alternative" as const },
    { label: "doba", price_type: "per_unit", price_value: 140, price_max: null, unit: "doba", quantity_from: "customer" as const, quantity_label: "", combine: "alternative" as const }] };
  const items = new Map<string, any>([["aaaaaaaa", pump], ["bbbbbbbb", { name: "Kozioł MINI", fields: { price_type: "fixed", unit: "szt" }, price_value: 240, price_max: null }], ["cccccccc", { name: "Kozioł MAXI", fields: { price_type: "fixed", unit: "szt" }, price_value: 350, price_max: null }]]);
  it("hourly charged where the daily rate is cheaper (C14/C19)", () => {
    const p = choiceProblems([{ czesc: "pompa", kryterium: "najtaniej", opcje: [{ id: "aaaaaaaa", ilosc: 30, jednostka: "godzina", suma: 840 }], wybrana: "aaaaaaaa" }], items);
    expect(p.join()).toMatch(/costs 280.*cheaper/);
  });
  it("the dearer option chosen when the customer wants the cheapest (C9)", () => {
    const c = [{ czesc: "kozioł", kryterium: "najtaniej", opcje: [{ id: "bbbbbbbb", ilosc: 1, jednostka: "szt", suma: 240 }, { id: "cccccccc", ilosc: 1, jednostka: "szt", suma: 350 }], wybrana: "cccccccc" }];
    expect(choiceProblems(c, items)).toEqual(["kozioł: chose 350 but the cheapest option is 240"]);
    expect(choiceProblems([{ ...c[0], wybrana: "bbbbbbbb" }], items)).toEqual([]);
    expect(choiceProblems([{ ...c[0], kryterium: "dokladnie_to" }], items)).toEqual([]);
  });
});
