/**
 * The customer's quantities counted by code (src/pricing/quantity.ts) and priced by code - the business's own program
 * (src/pricing/model.ts priceRequest, renderQuote) and an item's recipe (src/offer/quantities.ts priceGiven) - on the
 * three iteration-5 regressions: rentbud-1 ("Friday to Monday" read as 96 h = 480 zł; at the pickup time it is 3 doby =
 * 360 zł), sosnowydwor-3 (soup for 8 people at "1 l = 4 portions" = 2 l; the total 40 + 72 + 80 = 192 zł) and empro-1
 * (a shop's 3 batteries at 699 zł = 2097 zł). No model is called: the readers' answers are given as they would come.
 */
import { describe, it, expect } from "vitest";
import { periodReadings, convert, countInputs, readingsOf, isPeriod, dayNumber, clockHours, sameAmount, describeReading, type Period } from "./quantity.js";
import { priceRequest, renderQuote, catalogOf, TOTAL_ITEM, type PricingBusiness } from "./model.js";
import { priceGiven, customerPriceLine, listedAmounts } from "../offer/quantities.js";
import type { OfferItem } from "../offer/store.js";

const period = (from: string, to: string, fromTime: string | null = null, toTime: string | null = null, counts?: Period["counts"]): Period =>
  ({ from: { date: from, time: fromTime }, to: { date: to, time: toTime }, ...(counts ? { counts } : {}) });
const values = (p: Period, unit?: Parameters<typeof periodReadings>[1]) => periodReadings(p, unit).map((r) => r.value);

describe("periods counted with calendar arithmetic, in the price's own unit", () => {
  // 2026-11-06 is a Friday, 2026-11-09 the Monday after.
  it("no time given: the end at the start's time of day, and every calendar day in full (rentbud-1)", () => {
    expect(periodReadings(period("2026-11-06", "2026-11-09"))).toEqual([
      { value: 72, basis: "same_time", hours: 72 },
      { value: 96, basis: "whole_days", hours: 96 },
    ]);
    // A doba is 24 h from the pickup time: 3 doby, or 4 counting every day.
    expect(values(period("2026-11-06", "2026-11-09"), "day")).toEqual([3, 4]);
  });
  it("both times given: one reading, exact", () => {
    expect(periodReadings(period("2026-11-06", "2026-11-09", "08:00", "08:00"))).toEqual([{ value: 72, basis: "exact", hours: 72 }]);
    expect(values(period("2026-11-06", "2026-11-09", "08:00", "12:30"))).toEqual([76.5]);
    expect(values(period("2026-11-06", "2026-11-09", "08:00", "12:00"), "day")).toEqual([4]); // 76 h = 4 doby begun
    expect(values(period("2026-11-07", "2026-11-07", "08:00", "13:00"))).toEqual([5]);
  });
  it("one time missing: the same time of day, or as late as the day allows", () => {
    expect(periodReadings(period("2026-11-06", "2026-11-09", "16:00"))).toEqual([
      { value: 72, basis: "same_time", hours: 72 },
      { value: 80, basis: "to_day_end", hours: 80 },
    ]);
    expect(periodReadings(period("2026-11-06", "2026-11-09", null, "10:00"))).toEqual([
      { value: 72, basis: "same_time", hours: 72 },
      { value: 82, basis: "from_day_start", hours: 82 },
    ]);
  });
  it("one day without times: the whole day only (nothing is left of the same-time reading)", () => {
    expect(periodReadings(period("2026-11-07", "2026-11-07"))).toEqual([{ value: 24, basis: "whole_days", hours: 24 }]);
    expect(values(period("2026-11-07", "2026-11-07"), "day")).toEqual([1]);
  });
  it("nights, calendar days and weeks", () => {
    expect(values(period("2026-11-06", "2026-11-08"), "night")).toEqual([2]);
    expect(values(period("2026-11-06", "2026-11-06"), "night")).toEqual([]);
    expect(values(period("2026-11-07", "2026-11-08"), "calendar_day")).toEqual([2]);
    expect(values(period("2026-11-01", "2026-11-10"), "week")).toEqual([2]); // 216 h and 240 h: both 2 weeks begun - one reading
    expect(values(period("2026-11-01", "2026-11-08", "09:00", "09:00"), "week")).toEqual([1]);
  });
  it("calendar arithmetic: months, leap years, the end of DST (a doba ends at the same time of day)", () => {
    expect(values(period("2026-01-30", "2026-02-02"), "day")).toEqual([3, 4]);
    expect(values(period("2028-02-28", "2028-03-01"), "calendar_day")).toEqual([3]); // 2028 is a leap year
    expect(values(period("2027-02-28", "2027-03-01"), "calendar_day")).toEqual([2]);
    expect(values(period("2026-10-23", "2026-10-26", "10:00", "10:00"))).toEqual([72]); // DST ended on 2026-10-25
  });
  it("what cannot be counted: an end before the start, a date that does not exist, a time that is not one", () => {
    expect(periodReadings(period("2026-11-09", "2026-11-06"))).toEqual([]);
    expect(periodReadings(period("2026-11-07", "2026-11-07", "13:00", "08:00"))).toEqual([]);
    expect(dayNumber("2026-02-30")).toBeNull();
    expect(isPeriod(period("2026-02-30", "2026-03-02"))).toBe(false);
    expect(clockHours("25:00")).toBeNull();
    expect(clockHours("7:30")).toBe(7.5);
    // A time that is not one is not given: two readings.
    expect(values(period("2026-11-06", "2026-11-09", "rano"))).toEqual([72, 96]);
  });
  it("a reading says what it assumes, with the weekdays", () => {
    const p = period("2026-11-06", "2026-11-09");
    const [a, b] = periodReadings(p);
    expect(describeReading("hours", p, a)).toBe("hours from Friday 2026-11-06 to Monday 2026-11-09, ending at the same time of day as it starts = 72 h (3 x 24 h)");
    expect(describeReading("hours", p, b)).toBe("hours every calendar day from Friday 2026-11-06 to Monday 2026-11-09 counted in full = 96 h (4 x 24 h)");
  });
});

describe("quantities in another unit, converted as the item states", () => {
  it("soup for 8 people at 1 l = 4 portions is 2 l (sosnowydwor-3); 9 people 2.25 l", () => {
    expect(convert({ amount: 8, equals: { input: 1, given: 4 } })).toBe(2);
    expect(convert({ amount: 9, equals: { input: 1, given: 4 } })).toBe(2.25);
  });
  it("whole packs are rounded up (25 m² of tiles at 1.44 m² a box = 18 boxes); a length in days as hours", () => {
    expect(convert({ amount: 25, equals: { input: 1, given: 1.44 }, whole: true })).toBe(18);
    expect(convert({ amount: 2, equals: { input: 24, given: 1 } })).toBe(48);
  });
  it("a conversion that cannot be used is no quantity", () => {
    expect(convert({ amount: 8, equals: { input: 0, given: 4 } })).toBeNull();
    expect(convert({ amount: -1, equals: { input: 1, given: 4 } })).toBeNull();
    expect(readingsOf({ amount: 8, equals: { input: 1, given: 0 } })).toEqual([]);
    expect(readingsOf(8)).toBeNull(); // a number stays as it is
    expect(readingsOf("standard")).toBeNull();
  });
});

describe("a request's inputs counted together: one set per reading", () => {
  it("a period without times gives two sets; a conversion and plain values are the same in both", () => {
    const { sets, assumed } = countInputs([
      { hours: period("2026-11-06", "2026-11-09", null, null, "hour"), delivery: false },
      { quantity: { amount: 8, equals: { input: 1, given: 4 } } },
      { quantity: 40 },
    ]);
    expect(sets).toEqual([
      [{ hours: 72, delivery: false }, { quantity: 2 }, { quantity: 40 }],
      [{ hours: 96, delivery: false }, { quantity: 2 }, { quantity: 40 }],
    ]);
    expect(assumed[0]).toHaveLength(2);
    expect(assumed[1][0]).toContain("every calendar day");
  });
  it("a period whose unit nobody says is left out (the program then asks for it); unitOf says it for an input", () => {
    const p = period("2026-11-06", "2026-11-09", "08:00", "08:00");
    expect(countInputs([{ guests: p }]).sets).toEqual([[{}]]);
    expect(countInputs([{ hours: p }], (n) => (n === "hours" ? "hour" : undefined)).sets).toEqual([[{ hours: 72 }]]);
  });
});

// A business's program as the build writes them (QuickJS): Rentbud's rates (24 zł/h or 120 zł/doba, the cheapest mix;
// hours shared by every line) and Sosnowy Dwór's catering (per litre, per piece).
const PROGRAM = `
const catalog = { business: "Test", currency: "PLN", shared: [{ name: "hours", meaning: "rental duration in hours", type: "number", unit: "h" }], items: [
  { id: "plate", name: "Zagęszczarka 100 kg", inputs: [] },
  { id: "soup", name: "Barszczyk czerwony z uszkami", inputs: [{ name: "quantity", meaning: "litres", type: "number", unit: "l" }] },
  { id: "dumplings", name: "Pierogi domowe mix", inputs: [{ name: "quantity", meaning: "pieces", type: "number", unit: "piece" }] },
  { id: "carp", name: "Filet z karpia smażony", inputs: [{ name: "quantity", meaning: "pieces", type: "number", unit: "piece" }] }] };
const PER = { soup: 20, dumplings: 1.8, carp: 10 };
function mix(h) { const d = Math.floor(h / 24), r = h - d * 24; return d * 120 + Math.min(r * 24, r > 0 ? 120 : 0); }
function needs(req) { return []; }
function quote(req) {
  return { lines: req.lines.map((l) => {
    if (l.item === "plate") { const h = (l.inputs && l.inputs.hours) || req.context.hours; return typeof h === "number" ? { item: l.item, status: "price", amount: mix(h) } : { item: l.item, status: "needs", needs: ["hours"] }; }
    const q = l.inputs && l.inputs.quantity;
    return typeof q === "number" ? { item: l.item, status: "price", amount: Math.round(q * PER[l.item] * 100) / 100 } : { item: l.item, status: "needs", needs: ["quantity"] };
  }), total: null, rules: [] };
}`;
const catalogue = {
  business: "Test", currency: "PLN", shared: [{ name: "hours", meaning: "rental duration in hours", type: "number" as const, unit: "h" }],
  items: [
    { id: "plate", name: "Zagęszczarka 100 kg", inputs: [] },
    { id: "soup", name: "Barszczyk czerwony z uszkami", inputs: [{ name: "quantity", meaning: "litres", type: "number" as const, unit: "l" }] },
    { id: "dumplings", name: "Pierogi domowe mix", inputs: [{ name: "quantity", meaning: "pieces", type: "number" as const, unit: "piece" }] },
    { id: "carp", name: "Filet z karpia smażony", inputs: [{ name: "quantity", meaning: "pieces", type: "number" as const, unit: "piece" }] },
  ],
};
const business: PricingBusiness = { tenantId: "test", hash: "", builtAt: "", model: "", costUsd: 0, missing: [], parts: [{ catalog: catalogue, code: PROGRAM, source: "", model: "" }] };
const priced = async (request: Parameters<typeof priceRequest>[1]) => {
  const { quotes, assumed } = await priceRequest(business, request);
  return renderQuote(catalogOf(business), quotes, assumed);
};

describe("the business's program on counted quantities: line totals, the total, the facts for the check", () => {
  it("rentbud-1: Friday to Monday without times - 3 doby = 360 zł, or 4 = 480 zł, both given", async () => {
    const q = await priced({ context: { hours: period("2026-11-06", "2026-11-09", null, null, "hour") }, lines: [{ item: "plate", inputs: {}, need: "n0" }] });
    expect(q.covered).toBe(true);
    expect(q.text).toContain("- Zagęszczarka 100 kg: A: 360 PLN");
    expect(q.text).toContain("B: 480 PLN");
    expect(q.text).toContain("Total: A: 360 PLN; B: 480 PLN");
    expect(q.text).toContain("every calendar day from Friday 2026-11-06 to Monday 2026-11-09");
    // One fact per reading: the check pairs an amount with the reading it is given for ("3 doby" is A's 72 h, not B's 96 h).
    expect(q.facts).toEqual([
      { item: "Zagęszczarka 100 kg", kind: "computed", reading: "A", readingText: expect.stringContaining("= 72 h"), amounts: [360], line: expect.stringContaining("Zagęszczarka") },
      { item: "Zagęszczarka 100 kg", kind: "computed", reading: "B", readingText: expect.stringContaining("= 96 h"), amounts: [480], line: expect.stringContaining("Zagęszczarka") },
      { item: TOTAL_ITEM, kind: "computed", reading: "A", readingText: expect.stringContaining("= 72 h"), amounts: [360], line: expect.stringContaining("Total") },
      { item: TOTAL_ITEM, kind: "computed", reading: "B", readingText: expect.stringContaining("= 96 h"), amounts: [480], line: expect.stringContaining("Total") },
    ]);
  });
  it("rentbud: with the times given, one reading (Friday 8:00 - Monday 12:00 = 76 h = 3 doby + 4 h)", async () => {
    const q = await priced({ context: { hours: period("2026-11-06", "2026-11-09", "08:00", "12:00", "hour") }, lines: [{ item: "plate", inputs: {}, need: "n0" }] });
    expect(q.text).toContain("- Zagęszczarka 100 kg: 456 PLN for this request");
    expect(q.text).toContain("Counted from the customer's words: hours from Friday 2026-11-06 08:00 to Monday 2026-11-09 12:00 = 76 h");
    expect(q.text).toContain("Total: 456 PLN");
  });
  it("sosnowydwor-3: soup for 8 at 1 l = 4 portions, 40 dumplings, 8 carp - 40 + 72 + 80 = 192 zł", async () => {
    const q = await priced({ context: {}, lines: [
      { item: "soup", inputs: { quantity: { amount: 8, equals: { input: 1, given: 4 } } }, need: "n0" },
      { item: "dumplings", inputs: { quantity: 40 }, need: "n1" },
      { item: "carp", inputs: { quantity: 8 }, need: "n2" },
    ] });
    expect(q.covered).toBe(true);
    expect(q.missing).toBe(0);
    expect(q.text).toContain("- Barszczyk czerwony z uszkami: 40 PLN");
    expect(q.text).toContain("- Pierogi domowe mix: 72 PLN");
    expect(q.text).toContain("- Filet z karpia smażony: 80 PLN");
    expect(q.text).toContain("Total: 192 PLN");
    expect(q.facts.map((f) => f.amounts)).toEqual([[40], [72], [80], [192]]);
    expect(q.text).toContain("quantity 2 (8 as the customer gives it; 1 of quantity = 4, as the item states)");
  });
  it("a line still needing a quantity: the total says it is of the priced lines only, and which line it leaves out", async () => {
    const q = await priced({ context: {}, lines: [
      { item: "soup", inputs: {}, need: "n0" },
      { item: "dumplings", inputs: { quantity: 40 }, need: "n1" },
      { item: "carp", inputs: { quantity: 8 }, need: "n2" },
    ] });
    expect(q.covered).toBe(false);
    expect(q.missing).toBe(1);
    expect(q.text).toContain("- Barszczyk czerwony z uszkami: needs: quantity (ask the customer)");
    expect(q.text).toContain("Total of the priced lines only (without Barszczyk czerwony z uszkami): 152 PLN");
  });
});

// Two options for one need whose cheapest flips between the readings (150 zł a doba vs a 520 zł package for up to 96 h):
// every option keeps its amount under both readings, each reading with its own note (review 2026-11-05: "B: not priced").
const OPTIONS = `
const catalog = { business: "Test", currency: "PLN", shared: [{ name: "hours", meaning: "rental duration in hours", type: "number", unit: "h" }], items: [
  { id: "daily", name: "Stawka dobowa", inputs: [] }, { id: "weekend", name: "Pakiet weekendowy (do 96 h)", inputs: [] }] };
function needs(req) { return []; }
function quote(req) {
  const h = req.context.hours;
  return { lines: req.lines.map((l) => l.item === "daily" ? { item: l.item, status: "price", amount: Math.ceil(h / 24) * 150, note: h + " h = " + Math.ceil(h / 24) + " doby" }
    : h <= 96 ? { item: l.item, status: "price", amount: 520, note: h + " h within the package" } : { item: l.item, status: "not_offered" }), total: null, rules: [] };
}`;
const optionsBusiness: PricingBusiness = { tenantId: "test2", hash: "", builtAt: "", model: "", costUsd: 0, missing: [], parts: [{ catalog: { business: "Test", currency: "PLN", shared: [{ name: "hours", meaning: "rental duration in hours", type: "number", unit: "h" }], items: [{ id: "daily", name: "Stawka dobowa", inputs: [] }, { id: "weekend", name: "Pakiet weekendowy (do 96 h)", inputs: [] }] }, code: OPTIONS, source: "", model: "" }] };

describe("two readings whose cheapest option flips", () => {
  it("every option priced under both readings, each with its own note; a fact per reading", async () => {
    const request = { context: { hours: period("2026-11-06", "2026-11-09", null, null, "hour") }, lines: [{ item: "daily", inputs: {}, need: "n0" }, { item: "weekend", inputs: {}, need: "n0" }] };
    const { quotes, assumed } = await priceRequest(optionsBusiness, request);
    const q = renderQuote(catalogOf(optionsBusiness), quotes, assumed);
    expect(q.text).toContain("- Stawka dobowa (one option): A: 450 PLN for this request (the customer's quantities, everything in the note included) (72 h = 3 doby); B: 600 PLN");
    expect(q.text).toContain("(96 h = 4 doby)");
    expect(q.text).not.toContain("not priced");
    expect(q.text).toContain("- Pakiet weekendowy (do 96 h) (another option for the same thing): 520 PLN");
    expect(q.facts.map((f) => [f.item, f.reading ?? "", f.amounts])).toEqual([["Stawka dobowa", "A", [450]], ["Stawka dobowa", "B", [600]], ["Pakiet weekendowy (do 96 h)", "", [520]]]);
  });
});

// Offer items as the scrape reads them (src/offer/store.ts).
const item = (over: Partial<OfferItem> & { name: string }): OfferItem => ({
  id: over.name, category: "", description: "", fields: {}, price_value: null, price_max: null, currency: "PLN", components: [], source: "website", owner_set: [], url: "", updatedAt: "", ...over,
} as OfferItem);

describe("an item's recipe on the matcher's quantities (src/offer/quantities.ts)", () => {
  it("empro-1: a shop's battery at 699 zł, 3 pieces = 2097 zł", () => {
    const battery = item({ name: "M18 HIGH OUTPUT akumulator 5.5 Ah", fields: { kind: "product", price_type: "fixed" }, price_value: 699, source: "shop" });
    const [p] = priceGiven(new Map([[battery, { pieces: 3 }]]));
    expect(p.readings).toEqual([{ given: { pieces: 3 }, amount: 2097, what: "pieces 3" }]);
    expect(customerPriceLine(p)).toBe("M18 HIGH OUTPUT akumulator 5.5 Ah, for the customer's pieces 3: 2097 zł (computed from our price list)");
    expect(listedAmounts(battery)).toEqual([699]);
  });
  it("rentbud-1: hourly or daily rate from Friday to Monday - 360 zł or 480 zł, both readings in the line", () => {
    const plate = item({ name: "Zagęszczarka 100 kg", fields: { kind: "rental" }, components: [
      { label: "Stawka godzinowa", price_type: "per_unit", price_value: 24, price_max: null, unit: "godzina", quantity_from: "customer", quantity_label: "", combine: "alternative" },
      { label: "Stawka dobowa", price_type: "per_unit", price_value: 120, price_max: null, unit: "doba", quantity_from: "customer", quantity_label: "", combine: "alternative" },
    ] as OfferItem["components"] });
    const [p] = priceGiven(new Map([[plate, { hours: period("2026-11-06", "2026-11-09") }]]));
    expect(p.readings.map((r) => r.amount)).toEqual([360, 480]);
    expect(customerPriceLine(p)).toContain("360 zł for hours from Friday 2026-11-06 to Monday 2026-11-09, ending at the same time of day as it starts = 72 h (3 x 24 h); or 480 zł for hours every calendar day");
    expect(listedAmounts(plate)).toEqual([24, 120]);
  });
  it("sosnowydwor-3: soup per litre for 8 people at 1 l = 4 portions - 2 l = 40 zł", () => {
    const soup = item({ name: "Barszczyk czerwony z uszkami", description: "Barszczyk czerwony z uszkami, 1 l = 4 porcje", fields: { kind: "product", price_type: "per_unit", unit: "litr" }, price_value: 20 });
    const [p] = priceGiven(new Map([[soup, { litres: { amount: 8, equals: { input: 1, given: 4 } } }]]));
    expect(p.readings).toEqual([{ given: { litres: 2 }, amount: 40, what: "litres 2 (8 as the customer gives it; 1 of litres = 4, as the item states)" }]);
  });
  it("a quantity that cannot be counted prices nothing", () => {
    const soup = item({ name: "Zupa", fields: { kind: "product", price_type: "per_unit", unit: "litr" }, price_value: 20 });
    expect(priceGiven(new Map([[soup, { litres: { amount: 8, equals: { input: 1, given: 0 } } }]]))).toEqual([]);
  });
});

describe("amounts compared by code", () => {
  it("equal to a computed amount within a cent", () => {
    expect(sameAmount(192, [40, 72, 80, 192])).toBe(true);
    expect(sameAmount(1704.87, [1704.87])).toBe(true);
    expect(sameAmount(2096, [2097])).toBe(false);
    expect(sameAmount(Number("x"), [1])).toBe(false);
  });
});
