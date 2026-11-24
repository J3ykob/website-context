import { describe, it, expect } from "vitest";
import { quoteBusiness, catalogFor, type PricingBusiness } from "./model.js";

// Two parts of one shop: the category list (names and symbols, no price) built first, the product pages second.
const part = (items: { id: string; inputs: string[] }[], body: string) => ({
  catalog: { business: "shop", currency: "PLN", shared: [], items: items.map((i) => ({ id: i.id, name: i.id, inputs: i.inputs.map((name) => ({ name, meaning: name, type: "number" as const })) })) },
  code: `const catalog = {}; function needs() { return []; } function quote(r) { return { lines: r.lines.map(function (l) { ${body} }), total: null, rules: [] }; }`,
  source: "", model: "",
});
const list = part([{ id: "SH-1", inputs: [] }, { id: "SH-2", inputs: [] }], `return { item: l.item, status: "on_request", note: "no price on the pages" };`);
const products = part([{ id: "SH-1", inputs: ["weight_kg"] }], `return l.inputs.weight_kg ? { item: l.item, status: "price", amount: 95 * l.inputs.weight_kg } : { item: l.item, status: "needs", needs: ["weight_kg"] };`);
const shop = (): PricingBusiness => ({ tenantId: "t", hash: "", builtAt: "", model: "", costUsd: 0, missing: [], parts: [list, products] });

describe("an item that several parts of a quoting model have", () => {
  it("is quoted by the part that prices it, not by the first part that names it", async () => {
    const q = await quoteBusiness(shop(), { context: {}, lines: [{ item: "SH-1", inputs: { weight_kg: 2 } }] });
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0]).toMatchObject({ status: "price", amount: 190 });
  });
  it("stays with the only part that has it, also when that part has no price", async () => {
    const q = await quoteBusiness(shop(), { context: {}, lines: [{ item: "SH-2", inputs: {} }] });
    expect(q.lines[0].status).toBe("on_request");
  });
  it("is shown to the reader once, with the inputs of the part that prices it", async () => {
    const c = await catalogFor(shop());
    expect(c.items.map((i) => i.id)).toEqual(["SH-2", "SH-1"]);
    expect(c.items.find((i) => i.id === "SH-1")!.inputs.map((x) => x.name)).toEqual(["weight_kg"]);
  });
});

describe("a charge every part adds once per order", () => {
  // Each part knows the delivery fee from the terms and adds it when the order is delivered.
  const withFee = (id: string) => part([{ id, inputs: [] }, { id: "delivery", inputs: [] }], `return { item: l.item, status: "price", amount: l.item === "delivery" ? 19.5 : 190 }; }).concat(r.context.delivery && !r.lines.some(function (l) { return l.item === "delivery"; }) ? [{ item: "delivery", status: "price", amount: 19.5 }] : []).map(function (l) { return l;`);
  const two = (): PricingBusiness => ({ tenantId: "t", hash: "", builtAt: "", model: "", costUsd: 0, missing: [], parts: [withFee("A"), withFee("B")] });
  it("is counted once when it is also asked for as a line", async () => {
    const q = await quoteBusiness(two(), { context: { delivery: true }, lines: [{ item: "B", inputs: {} }, { item: "delivery", inputs: {} }] });
    expect(q.lines.filter((l) => l.item === "delivery")).toHaveLength(1);
    expect(q.total).toEqual({ min: 209.5, max: 209.5 });
  });
  it("is counted once when two parts add it", async () => {
    const q = await quoteBusiness(two(), { context: { delivery: true }, lines: [{ item: "A", inputs: {} }, { item: "B", inputs: {} }] });
    expect(q.lines.filter((l) => l.item === "delivery")).toHaveLength(1);
    expect(q.total).toEqual({ min: 399.5, max: 399.5 });
  });
});
