/**
 * The reply's amounts compared by code (src/pricing/amounts.ts judgeAmounts) on the amounts call's answers as the probes
 * got them (2026-11-05) - no model here.
 */
import { describe, it, expect } from "vitest";
import { judgeAmounts, amountsView } from "./amounts.js";
import { TOTAL_ITEM, type QuoteFact } from "./model.js";

const C = (item: string, amounts: number[], extra: Partial<QuoteFact> = {}): QuoteFact => ({ item, kind: "computed", amounts, line: `- ${item}: ${amounts.join(" / ")} PLN for this request`, ...extra });
const L = (item: string, amounts: number[]): QuoteFact => ({ item, kind: "listed", amounts, line: "" });
const answer = (...statements: { n: number; amounts: { amount: number; item: number | null; as?: string; reading?: string | null }[]; other?: boolean }[]) => ({ statements: statements.map((s) => ({ other: false, ...s })) });

describe("amounts bound to what the reply gives them for", () => {
  const facts = [C("Zagęszczarka 100 kg", [360], { reading: "A", readingText: "72 h" }), C("Zagęszczarka 100 kg", [480], { reading: "B", readingText: "96 h" }), C(TOTAL_ITEM, [360], { reading: "A" }), C(TOTAL_ITEM, [480], { reading: "B" }), L("Zagęszczarka 100 kg", [24, 120]), L("Zagęszczarka 90 kg", [22, 110])];
  it("the view names the items and what we have for each - never the amounts", () => {
    const v = amountsView(facts);
    expect(v).toContain("0: Zagęszczarka 100 kg (computed for the customer's quantity - readings A: 72 h / B: 96 h; listed price or rate)");
    expect(v).toContain("1: the request's total (computed for the customer's quantity - readings A:  / B: )");
    expect(v).toContain("2: Zagęszczarka 90 kg (listed price or rate)");
    expect(v).not.toMatch(/360|480|120|110/);
  });
  it("the right reading and listed rate pass; the other reading's amount and another item's rate do not", () => {
    const st = ["a", "b", "c"];
    const v = judgeAmounts(st, facts, answer(
      { n: 0, amounts: [{ amount: 24, item: 0, as: "listed" }, { amount: 120, item: 0, as: "listed" }] },
      { n: 1, amounts: [{ amount: 480, item: 0, as: "computed", reading: "B" }] },
      { n: 2, amounts: [{ amount: 480, item: 0, as: "computed", reading: "A" }, { amount: 110, item: 0, as: "listed" }] },
    ))!;
    expect(v.supported).toEqual([true, true, false]);
    expect(v.wrong.map((w) => [w.amount, w.statement])).toEqual([[480, 2], [110, 2]]);
    expect(v.wrong[0].text).toContain("480 for Zagęszczarka 100 kg (reading A) - computed:");
  });
  it("a unit price given as the price of the customer's quantity is wrong (3 batteries for 699 zł)", () => {
    const f = [C("M18 akumulator 5.5 Ah", [2097]), L("M18 akumulator 5.5 Ah", [699])];
    const right = judgeAmounts(["x"], f, answer({ n: 0, amounts: [{ amount: 2097, item: 0, as: "computed" }, { amount: 699, item: 0, as: "listed" }, { amount: 500, item: null }] }))!;
    expect(right.wrong).toEqual([]);
    expect(right.supported).toEqual([false]); // the 500 zł threshold is nothing we hold: not judged, so not "supported" either
    const wrong = judgeAmounts(["x"], f, answer({ n: 0, amounts: [{ amount: 699, item: 0, as: "computed" }] }))!;
    expect(wrong.wrong.map((w) => w.amount)).toEqual([699]);
  });
  it("not judged: a part of a computed price, a listed rate we don't hold, an item with nothing of that kind", () => {
    const f = [C("Pakiet Ekonomiczny", [5500]), L("Pakiet Ekonomiczny", [3500]), C("Menu weselne", [17100]), C(TOTAL_ITEM, [17100])];
    const v = judgeAmounts(["x", "y"], f, answer(
      { n: 0, amounts: [{ amount: 3500, item: 0, as: "listed" }, { amount: 500, item: 0, as: "listed" }, { amount: 2000, item: 0, as: "part" }, { amount: 5500, item: 0, as: "computed" }] },
      { n: 1, amounts: [{ amount: 285, item: 1, as: "listed" }, { amount: 18300, item: 2, as: "computed" }] },
    ))!;
    expect(v.wrong.map((w) => w.amount)).toEqual([18300]);
    expect([...v.given].sort()).toEqual([0, 1]);
  });
  it("a statement that also states something else is not supported; no answer is null", () => {
    const f = [C("Barszczyk", [40]), C(TOTAL_ITEM, [40])];
    expect(judgeAmounts(["x"], f, answer({ n: 0, amounts: [{ amount: 40, item: 0, as: "computed" }], other: true }))!.supported).toEqual([false]);
    expect(judgeAmounts(["x"], f, { statements: [] })).toBeNull();
    expect(judgeAmounts(["x"], f, null)).toBeNull();
  });
});
