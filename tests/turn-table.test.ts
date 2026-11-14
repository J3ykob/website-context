import { describe, it, expect } from "vitest";
import { decide, type TurnState } from "../src/llm/turn-table.js";

// A plain question our information answers in full; each test changes what it is about.
const base: TurnState = {
  intent: "ask", asksPrice: false, parts: [], info: "full", price: "none", missing: [], askedLast: false, formOpen: false,
  calc: "none", network: "off", owner: false, canOffer: true,
};
const s = (over: Partial<TurnState>): TurnState => ({ ...base, ...over });
const ours = { ours: "yes" as const, priced: true, denied: false };
const notOurs = { ours: "no" as const, priced: false, denied: false };
const deniedPart = { ours: "no" as const, priced: false, denied: true };

describe("turn table", () => {
  it("answers a question our information covers, with no offer", () => {
    const d = decide(base);
    expect(d).toMatchObject({ body: "answer", price: "plain", partial: false, offer: null, notOffered: [] });
  });

  it("no information: says so and offers to pass the question on", () => {
    expect(decide(s({ info: "none" }))).toMatchObject({ body: "noInfo", offer: "question" });
    expect(decide(s({ info: "none", canOffer: false }))).toMatchObject({ body: "noInfo", offer: null });
  });

  it("a detail missing: a question to the team, or a quote request when a price is asked and none is here", () => {
    expect(decide(s({ info: "partial" }))).toMatchObject({ body: "answer", partial: true, offer: "question" });
    expect(decide(s({ info: "partial", asksPrice: true, price: "none" }))).toMatchObject({ partial: true, offer: "quote" });
    expect(decide(s({ info: "partial", asksPrice: true, price: "listed" }))).toMatchObject({ partial: true, offer: "question" });
  });

  it("totals computed by code are given as computed", () => {
    expect(decide(s({ asksPrice: true, price: "computed" }))).toMatchObject({ body: "answer", price: "compute", offer: null });
    expect(decide(s({ intent: "calculate", asksPrice: true, calc: "simple", price: "listed" }))).toMatchObject({ price: "compute" });
  });

  it("a listed price whose total needs a quantity: asks for it once, instead of handing off", () => {
    const st = s({ asksPrice: true, price: "listed", missing: ["volume in m³"], info: "partial" });
    expect(decide(st)).toMatchObject({ body: "answer", price: "askInputs", partial: true, offer: null });
    expect(decide({ ...st, askedLast: true })).toMatchObject({ price: "plain", offer: "question" });
    expect(decide({ ...st, formOpen: true })).toMatchObject({ price: "plain" });
    expect(decide({ ...st, asksPrice: false })).toMatchObject({ price: "plain" });
  });

  it("a calculation our team prepares: a quote request", () => {
    expect(decide(s({ intent: "calculate", asksPrice: true, calc: "team", price: "listed" }))).toMatchObject({ price: "teamQuote", offer: "quote" });
  });

  it("a part our pages deny is told not in our offer, whatever else is asked", () => {
    expect(decide(s({ parts: [ours, deniedPart] }))).toMatchObject({ body: "answer", notOffered: [1] });
    // Nothing else known: the denial is the answer, and no detail is "missing".
    expect(decide(s({ parts: [deniedPart], info: "none" }))).toMatchObject({ body: "answer", notOffered: [0], partial: false, offer: null });
    // Not ours, but nothing says so: never told "not in our offer".
    expect(decide(s({ parts: [notOurs], info: "none" }))).toMatchObject({ body: "noInfo", notOffered: [] });
    // Could not be judged counts as ours.
    expect(decide(s({ parts: [{ ours: "unclear", priced: false, denied: true }] })).notOffered).toEqual([]);
  });

  it("the network answers in place of us only when asked for, nothing answers, or nothing is ours - and waits for the search", () => {
    const st = s({ parts: [notOurs], info: "none", network: "unknown" });
    expect(decide(st).needs).toBe("relay");
    expect(decide({ ...st, network: "found" })).toMatchObject({ body: "network", withOurs: false, offer: null });
    expect(decide({ ...st, network: "searching" })).toMatchObject({ body: "networkChecking" });
    expect(decide({ ...st, network: "none" })).toMatchObject({ body: "noInfo", offer: "question" });
    expect(decide(s({ intent: "elsewhere", network: "found" }))).toMatchObject({ body: "network", withOurs: true });
    // The owner is never sent to other businesses; with the network off nothing waits.
    expect(decide({ ...st, owner: true })).toMatchObject({ body: "noInfo" });
    expect(decide({ ...st, network: "off" }).needs).toBeUndefined();
  });

  it("a mixed request: our answer first, the network only offered for the parts we don't have", () => {
    const st = s({ parts: [ours, notOurs], network: "unknown" });
    expect(decide(st)).toMatchObject({ body: "answer", needs: "offer" });
    expect(decide({ ...st, network: "found" })).toMatchObject({ body: "answer", offer: "network" });
    expect(decide({ ...st, network: "none" })).toMatchObject({ body: "answer", offer: null });
    expect(decide({ ...st, network: "found", canOffer: false })).toMatchObject({ offer: null });
    // Everything ours: the network is never asked.
    expect(decide(s({ parts: [ours], network: "unknown" })).needs).toBeUndefined();
  });

  it("names the row that decided each column", () => {
    expect(decide(s({ info: "partial" })).rows).toEqual(["answer", "plain", "a detail missing", "offer - question to the team (a detail missing)"]);
  });
});
