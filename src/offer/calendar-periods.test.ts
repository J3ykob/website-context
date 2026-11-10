/**
 * A length of time the customer gives in calendar units (a year, N months, N weeks, N days, dates) priced in calendar units
 * against each rate's own unit (src/pricing/quantity.ts Span, src/offer/recipe.ts rates). whisp_so (production eval
 * 2026-11-07): "a jakbym wzial panel na caly rok to ile wyjdzie?" at 149 zł a month came to 8760 h / 720 = 13 months =
 * 1937 zł, and the amounts check rejected the reply's right 149 x 12 = 1788 zł. Rentals (hours, doby, weekends, the
 * cheapest mix of hour / day / week rates) are counted as before. No model is called.
 */
import { describe, it, expect } from "vitest";
import { evaluate, recipeFromFields, type Rule } from "./recipe.js";
import { priceGiven, customerPriceLine } from "./quantities.js";
import { durationSpan, durationReadings, periodReadings, readingsOf, countInputs, describeReading, dayNumber, type Duration, type Period } from "../pricing/quantity.js";
import { judgeAmounts } from "../pricing/amounts.js";
import type { QuoteFact } from "../pricing/model.js";
import type { OfferItem } from "./store.js";
import { choiceProblems } from "../projects/agent.js";
import { priceLine } from "../projects/compare.js";

const period = (from: string, to: string, fromTime: string | null = null, toTime: string | null = null): Period => ({ from: { date: from, time: fromTime }, to: { date: to, time: toTime } });
const item = (over: Partial<OfferItem> & { name: string }): OfferItem => ({
  id: over.name, category: "", description: "", fields: {}, price_value: null, price_max: null, currency: "PLN", components: [], source: "website", owner_set: [], url: "", updatedAt: "", ...over,
} as OfferItem);
const comp = (unit: string, price: number) => ({ label: unit, price_type: "per_unit", price_value: price, price_max: null, unit, quantity_from: "customer" as const, quantity_label: "", combine: "alternative" as const });
// Hours, days and weeks without dates are counted from today: the tests fix the day (2027-03-01: the next 12 months hold
// a 29-day February, so 365 days are 11 months + 28 days there).
const DAY = dayNumber("2026-11-10")!, LEAP = dayNumber("2027-03-01")!;
const span = (d: Duration, from = DAY) => durationSpan(d, from);
const price = (r: Rule, v: unknown) => evaluate(r, { hours: v as number });

const monthly = recipeFromFields({ fields: { kind: "service", price_type: "per_unit", unit: "miesiac" }, price_value: 149, price_max: null })!.price;
const weekly = recipeFromFields({ fields: { kind: "rental", price_type: "per_unit", unit: "tydzien" }, price_value: 500, price_max: null })!.price;
const weeklyDaily = recipeFromFields({ fields: { kind: "rental" }, price_value: null, price_max: null, components: [comp("doba", 100), comp("tydzien", 500)] })!.price;
// A rental with all four rates (hour 30, doba 120, week 600, month 1800).
const rental = recipeFromFields({ fields: { kind: "rental" }, price_value: null, price_max: null, components: [comp("godzina", 30), comp("doba", 120), comp("tydzien", 600), comp("miesiac", 1800)] })!.price;

describe("lengths in calendar units", () => {
  it("a year is 12 calendar months and 365 x 24 h; months 30 x 24 h each without dates", () => {
    expect(span({ count: 1, unit: "year" })).toEqual({ months: 12, rest: 0, hours: 8760 });
    expect(span({ count: 2, unit: "month" })).toEqual({ months: 2, rest: 0, hours: 1440 });
    expect(span({ count: 0.5, unit: "year" })).toEqual({ months: 6, rest: 0, hours: 4380 });
    expect(span({ count: 1.5, unit: "month" })).toEqual({ months: 1, rest: 360, hours: 1080 });
    expect(span({ count: 6, unit: "week" })).toEqual({ months: 1, rest: 288, hours: 1008 }); // 10 Nov - 10 Dec + 12 days
    expect(span({ count: 10, unit: "day" })).toEqual({ months: 0, rest: 240, hours: 240 });
  });
  it("days and weeks hold the calendar months from today: 52 weeks = 11 months + 30 days, 365 days = 12 months", () => {
    expect(span({ count: 52, unit: "week" })).toEqual({ months: 11, rest: 720, hours: 8736 });
    expect(span({ count: 365, unit: "day" })).toEqual({ months: 12, rest: 0, hours: 8760 });
    expect(span({ count: 365, unit: "day" }, LEAP)).toEqual({ months: 11, rest: 672, hours: 8760 });
    expect(span({ count: 8760, unit: "hour" })).toEqual({ months: 12, rest: 0, hours: 8760 });
  });
  it("counted in another unit for a business's program (a week = 7 doby, 7 calendar days)", () => {
    expect(durationReadings({ count: 1, unit: "week" }, "day").map((r) => r.value)).toEqual([7]);
    expect(readingsOf({ count: 3, unit: "day" }, "hour")).toEqual([{ value: 72, basis: "duration", hours: 72 }]);
    expect(readingsOf({ count: 3, unit: "day" })).toEqual([]); // no unit for the input: left out, as a period
    expect(countInputs([{ hours: { count: 2, unit: "week" } }], () => "hour").sets).toEqual([[{ hours: 336 }]]);
  });
  it("a period with dates keeps its calendar months (Jan 31 + 1 month = Feb 28)", () => {
    const [half] = periodReadings(period("2026-01-01", "2026-07-01"));
    expect(half.span).toEqual({ months: 6, rest: 0, hours: 4344 });
    const [feb] = periodReadings(period("2026-01-31", "2026-02-28"));
    expect(feb.span).toEqual({ months: 1, rest: 0, hours: 672 });
    // A rental weekend has no calendar month: no span, counted as before.
    expect(periodReadings(period("2026-11-06", "2026-11-09")).map((r) => r.span)).toEqual([undefined, undefined]);
  });
  it("a reading says what it counts", () => {
    const y = { count: 1, unit: "year" } as Duration;
    expect(describeReading("hours", y, durationReadings(y)[0], "hour")).toBe("hours 1 year = 12 calendar months; 365 x 24 h for rates that are not monthly");
    const w = { count: 6, unit: "week" } as Duration;
    expect(describeReading("hours", w, durationReadings(w, "hour", DAY)[0], "hour")).toBe("hours 6 weeks = 1 calendar month + 288 h counted from today; 42 x 24 h for rates that are not monthly");
    const d = { count: 3, unit: "day" } as Duration;
    expect(describeReading("hours", d, durationReadings(d, "hour", DAY)[0], "hour")).toBe("hours 3 days = 72 h (3 x 24 h)");
    // A number of hours: as before when it holds no calendar month.
    const h = { count: 30, unit: "hour" } as Duration;
    expect(describeReading("hours", h, durationReadings(h, "hour", DAY)[0], "hour")).toBe("hours 30");
  });
});

describe("priced against each rate's own unit", () => {
  it("a year at a monthly rate = 12 x the price (not 13: 8760 h / 720 h)", () => {
    expect(price(monthly, span({ count: 1, unit: "year" }))).toEqual({ kind: "price", amount: 1788 });
    expect(price(monthly, span({ count: 2, unit: "year" }))).toEqual({ kind: "price", amount: 3576 });
  });
  it("2 months at a monthly rate = 2 x; a month = 1", () => {
    expect(price(monthly, span({ count: 2, unit: "month" }))).toEqual({ kind: "price", amount: 298 });
    expect(price(monthly, span({ count: 1, unit: "month" }))).toEqual({ kind: "price", amount: 149 });
  });
  it("6 weeks at a weekly rate = 6 x", () => {
    expect(price(weekly, span({ count: 6, unit: "week" }))).toEqual({ kind: "price", amount: 3000 });
  });
  it("a year at a weekly rate: 52 weeks + 1 day - with a daily rate 52 x 500 + 100, with the weekly rate alone a 53rd week", () => {
    expect(price(weeklyDaily, span({ count: 1, unit: "year" }))).toEqual({ kind: "price", amount: 26100 });
    expect(price(weekly, span({ count: 1, unit: "year" }))).toEqual({ kind: "price", amount: 26500 });
  });
  it("a month at a weekly and daily rate: 30 days = 4 weeks + 2 doby", () => {
    expect(price(weeklyDaily, span({ count: 1, unit: "month" }))).toEqual({ kind: "price", amount: 2200 });
  });
  it("52 weeks, 365 days or 8760 h at a monthly rate = 12 x the price (not 13 by 720 h), also over a 29-day February", () => {
    for (const from of [DAY, LEAP]) {
      expect(price(monthly, span({ count: 52, unit: "week" }, from))).toEqual({ kind: "price", amount: 1788 });
      expect(price(monthly, span({ count: 365, unit: "day" }, from))).toEqual({ kind: "price", amount: 1788 });
      expect(price(monthly, span({ count: 8760, unit: "hour" }, from))).toEqual({ kind: "price", amount: 1788 });
    }
  });
  it("months with dates: 1 January - 1 July is 6 monthly rates (4344 h / 720 h would be 7)", () => {
    const [r] = periodReadings(period("2026-01-01", "2026-07-01"));
    expect(price(monthly, r.span)).toEqual({ kind: "price", amount: 894 });
  });
  it("months with dates and no times, the stated convention: the second reading counts the end day in full, so a monthly rate alone needs one more (1 day past the months)", () => {
    const year = periodReadings(period("2026-11-10", "2027-11-10"));
    expect(year.map((r) => r.basis)).toEqual(["same_time", "whole_days"]);
    expect(year.map((r) => r.span)).toEqual([{ months: 12, rest: 0, hours: 8760 }, { months: 12, rest: 24, hours: 8784 }]);
    expect(year.map((r) => price(monthly, r.span))).toEqual([{ kind: "price", amount: 1788 }, { kind: "price", amount: 1937 }]);
    expect(periodReadings(period("2026-01-01", "2026-07-01")).map((r) => price(monthly, r.span))).toEqual([{ kind: "price", amount: 894 }, { kind: "price", amount: 1043 }]);
  });
  it("months and the hours beyond them: the cheapest of the monthly rates plus the rest, or the other rates alone", () => {
    // 1.5 months: 1 month (1800) + 15 days = 2 weeks + 1 doba (1320) = 3120, cheaper than 2 months (3600).
    expect(price(rental, span({ count: 1.5, unit: "month" }))).toEqual({ kind: "price", amount: 3120 });
    // A year at the four rates: 12 months (21600) beats 52 weeks + 1 doba (31320).
    expect(price(rental, span({ count: 1, unit: "year" }))).toEqual({ kind: "price", amount: 21600 });
    // A monthly rate dearer than the weeks it covers: the weeks are taken.
    const dear = recipeFromFields({ fields: { kind: "rental" }, price_value: null, price_max: null, components: [comp("tydzien", 100), comp("miesiac", 1000)] })!.price;
    expect(price(dear, span({ count: 2, unit: "month" }))).toEqual({ kind: "price", amount: 900 }); // 60 days = 9 weeks
  });
});

describe("rentals counted as before", () => {
  it("hours, doby, a week: the cheapest mix of hour / day / week rates; the same with a length given as a span", () => {
    expect(price(rental, 5)).toEqual({ kind: "price", amount: 120 });
    expect(price(rental, 3)).toEqual({ kind: "price", amount: 90 });
    expect(price(rental, 30)).toEqual({ kind: "price", amount: 240 });
    expect(price(rental, 10 * 24)).toEqual({ kind: "price", amount: 960 }); // a week + 3 doby
    expect(price(rental, span({ count: 10, unit: "day" }))).toEqual({ kind: "price", amount: 960 });
    expect(price(rental, span({ count: 2, unit: "week" }))).toEqual({ kind: "price", amount: 1200 });
  });
  it("Friday to Monday without times: 3 or 4 doby, both readings with what they assume", () => {
    const plate = item({ name: "Zagęszczarka 100 kg", fields: { kind: "rental" }, components: [comp("godzina", 24), comp("doba", 120)] as OfferItem["components"] });
    const [p] = priceGiven(new Map([[plate, { hours: period("2026-11-06", "2026-11-09") }]]));
    expect(p.readings.map((r) => r.amount)).toEqual([360, 480]);
    expect(p.readings.map((r) => r.given)).toEqual([{ hours: 72 }, { hours: 96 }]);
    expect(customerPriceLine(p)).toContain("ending at the same time of day as it starts = 72 h (3 x 24 h); or 480 zł");
  });
  it("a weekend with times: Saturday 8:00 to Monday 8:00 = 2 doby; Friday 8:00 to Monday 12:00 = 3 doby + 4 h", () => {
    const plate = item({ name: "Zagęszczarka 100 kg", fields: { kind: "rental" }, components: [comp("godzina", 24), comp("doba", 120)] as OfferItem["components"] });
    expect(priceGiven(new Map([[plate, { hours: period("2026-11-07", "2026-11-09", "08:00", "08:00") }]]))[0].readings.map((r) => r.amount)).toEqual([240]);
    expect(priceGiven(new Map([[plate, { hours: period("2026-11-06", "2026-11-09", "08:00", "12:00") }]]))[0].readings.map((r) => r.amount)).toEqual([456]);
  });
  it("a range per doba is priced per doba, not per hour; an open one (from 100 zł a doba) keeps no highest", () => {
    const r = recipeFromFields({ fields: { kind: "rental", price_type: "range", unit: "doba" }, price_value: 100, price_max: 150 })!.price;
    expect(price(r, 72)).toEqual({ kind: "range", min: 300, max: 450 });
    const open = recipeFromFields({ fields: { kind: "rental", price_type: "range", unit: "doba" }, price_value: 100, price_max: null });
    expect(open!.inputs.map((i) => i.name)).toEqual(["hours"]);
    expect(price(open!.price, 72)).toEqual({ kind: "range", min: 300, max: null });
    expect(price(open!.price, 120)).toEqual({ kind: "range", min: 500, max: null });
  });
  it("the agent's choice check counts months the same way (12 miesięcy at 149 = 1788)", () => {
    const items = new Map<string, any>([["aaaaaaaa", { name: "Panel", fields: { price_type: "per_unit", unit: "miesiac" }, price_value: 149, price_max: null }]]);
    expect(choiceProblems([{ czesc: "panel", opcje: [{ id: "aaaaaaaa", ilosc: 12, jednostka: "miesiac", suma: 1788 }] }], items)).toEqual([]);
    expect(choiceProblems([{ czesc: "panel", opcje: [{ id: "aaaaaaaa", ilosc: 12, jednostka: "miesiac", suma: 1937 }] }], items).join()).toContain("costs 1788");
    // 52 weeks hold 11 calendar months + under one more from any day: 12 rates.
    expect(choiceProblems([{ czesc: "panel", opcje: [{ id: "aaaaaaaa", ilosc: 52, jednostka: "tydzien", suma: 1788 }] }], items)).toEqual([]);
  });
  it("the network quote lines count the same way (52 weeks at a monthly rate = 12; 3 doby at a daily or weekly rate as before)", () => {
    const b = { tenantId: "t", label: "T", items: [] };
    const box = item({ name: "Kontener", fields: { kind: "rental" }, components: [comp("tydzien", 500), comp("miesiac", 1500)] as OfferItem["components"] });
    const year = priceLine(box, { need: "kontener", needInCatalog: "kontener", quantity: 52, unit: "tydzien" }, b);
    expect([year.total, year.unit, year.priceNote]).toEqual([18000, "miesiac", "miesiac × 12"]);
    const plate = item({ name: "Zagęszczarka", fields: { kind: "rental" }, components: [comp("doba", 120), comp("tydzien", 300)] as OfferItem["components"] });
    expect(priceLine(plate, { need: "z", needInCatalog: "z", quantity: 3, unit: "doba" }, b).total).toBe(300);
    expect(priceLine(plate, { need: "z", needInCatalog: "z", quantity: 2, unit: "doba" }, b).total).toBe(240);
  });
});

describe("whisp_so: the business panel for a whole year", () => {
  const panel = item({ name: "Whisp business panel", fields: { kind: "service", price_type: "per_unit", unit: "miesiac" }, price_value: 149 });
  // The quantity reader's answer for "na cały rok" (src/offer/search.ts READ): a length in the customer's own unit.
  const [p] = priceGiven(new Map([[panel, { hours: { count: 1, unit: "year" } }]]));
  const line = customerPriceLine(p);
  it("1788 zł = 12 x 149 zł", () => {
    expect(p.readings.map((r) => r.amount)).toEqual([1788]);
    expect(line).toBe("Whisp business panel, for the customer's hours 1 year = 12 calendar months; 365 x 24 h for rates that are not monthly: 1788 zł (computed from our price list)");
  });
  it("the same when the reader still converts to hours (8760, the production reading): 12 calendar months from today", () => {
    const [h] = priceGiven(new Map([[panel, { hours: 8760 }]]), DAY);
    expect(h.readings.map((r) => [r.amount, r.given])).toEqual([[1788, { hours: 8760 }]]);
    expect(customerPriceLine(h)).toBe("Whisp business panel, for the customer's hours 8760 h = 12 calendar months counted from today; 365 x 24 h for rates that are not monthly: 1788 zł (computed from our price list)");
    expect(priceGiven(new Map([[panel, { hours: 8760 }]]), LEAP)[0].readings.map((r) => r.amount)).toEqual([1788]);
  });
  it("the amounts check takes the reply's 149 x 12 = 1 788 zł and rejects 1937 zł", () => {
    // The facts as the chat builds them from the computed price (src/llm/chat.ts computedFacts).
    const facts: QuoteFact[] = [{ item: panel.name, kind: "computed", amounts: [p.readings[0].amount], line }, { item: panel.name, kind: "listed", amounts: [149], line: "" }];
    const right = judgeAmounts(["Panel na rok: 149 zł x 12 = 1 788 zł."], facts, { statements: [{ n: 0, amounts: [{ amount: 149, item: 0, as: "listed" }, { amount: 1788, item: 0, as: "computed" }], other: false }] })!;
    expect(right.wrong).toEqual([]);
    expect(right.supported).toEqual([true]);
    const wrong = judgeAmounts(["Panel na rok: 1 937 zł."], facts, { statements: [{ n: 0, amounts: [{ amount: 1937, item: 0, as: "computed" }], other: false }] })!;
    expect(wrong.wrong.map((w) => w.amount)).toEqual([1937]);
  });
});
