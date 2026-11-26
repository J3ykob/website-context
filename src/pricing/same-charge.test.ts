import { describe, it, expect, vi } from "vitest";

// Jev: "travel" items are one charge, whatever they are called; `jev.calls` counts the questions asked.
const jev = { calls: 0, down: false };
vi.mock("../llm/jev.js", () => ({
  jevAsk: async (state: { added: string; others: string[] }) => { jev.calls++; return jev.down ? null : Object.fromEntries(state.others.map((o, k) => [`s${k}`, { noul: /Dojazd/.test(state.added) && /Dojazd/.test(o) ? 0.95 : 0.05 }])); },
}));
import { quoteBusiness, type PricingBusiness } from "./model.js";

const part = (items: { id: string; name: string }[], prices: Record<string, number>, extra: string) => ({
  catalog: { business: "x", currency: "PLN", shared: [], items: items.map((i) => ({ ...i, inputs: [] })) },
  code: `const catalog = {}; const P = ${JSON.stringify(prices)}; function needs() { return []; } function quote(r) { var out = r.lines.map(function (l) { return { item: l.item, status: "price", amount: P[l.item] }; }); if (r.context.travel && ${extra}) out.push(${extra}); return { lines: out, total: null, rules: [] }; }`,
  source: "", model: "",
});
// The make-up part adds its own travel; the booking-page part has the travel under another id and another name.
const pb = (): PricingBusiness => ({ tenantId: "t", hash: "", builtAt: "", model: "", costUsd: 0, missing: [], parts: [
  part([{ id: "makijaz", name: "Makijaż okolicznościowy" }, { id: "dojazd", name: "Dojazd do klientki" }], { makijaz: 300, dojazd: 100 }, `{ item: "dojazd", status: "price", amount: 100 }`),
  part([{ id: "dojazd_warszawa", name: "Dojazd na terenie Warszawy" }, { id: "kepki", name: "Kępki rzęs" }], { dojazd_warszawa: 100, kepki: 100 }, "null"),
] });

describe("the same charge under another id and another name", () => {
  it("is counted once: the line the part added goes, the one asked for stays", async () => {
    const q = await quoteBusiness(pb(), { context: { travel: true }, lines: [{ item: "makijaz", inputs: {} }, { item: "dojazd_warszawa", inputs: {} }] });
    expect(q.lines.map((l) => l.item).sort()).toEqual(["dojazd_warszawa", "makijaz"]);
    expect(q.total).toEqual({ min: 400, max: 400 });
  });
  it("another thing with the same amount is not taken for it", async () => {
    const q = await quoteBusiness(pb(), { context: { travel: true }, lines: [{ item: "makijaz", inputs: {} }, { item: "kepki", inputs: {} }] });
    expect(q.lines.map((l) => l.item).sort()).toEqual(["dojazd", "kepki", "makijaz"]);
    expect(q.total).toEqual({ min: 500, max: 500 });
  });
  it("is asked once per pair for a loaded model, and never when no part added a line", async () => {
    const model = pb();
    jev.calls = 0;
    const req = { context: { travel: true }, lines: [{ item: "makijaz", inputs: {} }, { item: "dojazd_warszawa", inputs: {} }] };
    await quoteBusiness(model, req); await quoteBusiness(model, req);
    expect(jev.calls).toBe(1);
    await quoteBusiness(model, { context: {}, lines: [{ item: "makijaz", inputs: {} }, { item: "dojazd_warszawa", inputs: {} }] });
    expect(jev.calls).toBe(1);
  });
  it("Jev not answering: both stay (nothing is dropped on a guess)", async () => {
    jev.down = true;
    const q = await quoteBusiness(pb(), { context: { travel: true }, lines: [{ item: "makijaz", inputs: {} }, { item: "dojazd_warszawa", inputs: {} }] });
    expect(q.total).toEqual({ min: 500, max: 500 });
    jev.down = false;
  });
});
