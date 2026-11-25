import { describe, it, expect } from "vitest";
import { buildBusiness, type Llm } from "./model.js";

// Three pages, each long enough to be a part of its own; the generator writes a one-item program named after the page.
const pages = ["a", "b", "c"].map((n) => ({ url: `https://x.pl/${n}`, text: `page-${n} `.repeat(3500) }));
const maker = (fail?: string) => {
  const state = { calls: [] as string[], now: 0, most: 0 };
  const gen: Llm = async (_s, user) => {
    const n = /page-(\w)/.exec(user)![1];
    state.calls.push(n); state.most = Math.max(state.most, ++state.now);
    await new Promise((r) => setTimeout(r, 20));
    state.now--;
    if (n === fail) throw new Error("no answer");
    return "```js\nconst catalog = { business: 'x', currency: 'PLN', shared: [], items: [{ id: '" + n + "', name: '" + n + "', inputs: [] }] };\nfunction needs() { return []; }\nfunction quote(r) { return { lines: r.lines.map(function (l) { return { item: l.item, status: 'price', amount: 10 }; }), total: null, rules: [] }; }\n```";
  };
  const check: Llm = async () => '{"cases": []}';
  return { state, llms: { gen, check } };
};
const ids = (pb: { parts: { catalog: { items: { id: string }[] } }[] }) => pb.parts.map((p) => p.catalog.items[0].id);

describe("a quoting model built in parts", () => {
  it("builds several parts at once and keeps them in the pages' order", async () => {
    const m = maker();
    const pb = await buildBusiness("t", "x", pages, [], "test", m.llms, [], { concurrency: 3 });
    expect(ids(pb)).toEqual(["a", "b", "c"]);
    expect(m.state.most).toBeGreaterThan(1);
  }, 20000);

  it("a build that lost a part is finished from the stored model: only the missing part is built", async () => {
    const lost = maker("b");
    const first = await buildBusiness("t", "x", pages, [], "test", lost.llms, [], { concurrency: 3 });
    expect(ids(first)).toEqual(["a", "c"]);
    expect(first.failed).toHaveLength(1);
    const m = maker(), seen: string[] = [];
    const pb = await buildBusiness("t", "x", pages, [], "test", m.llms, [], { concurrency: 3, prev: first, onPart: (k, of, how) => seen.push(`${k + 1}/${of} ${how}`) });
    expect(ids(pb)).toEqual(["a", "b", "c"]);
    expect(new Set(m.state.calls)).toEqual(new Set(["b"]));
    expect(seen.sort()).toEqual(["1/3 kept", "2/3 built", "3/3 kept"]);
  }, 20000);

  it("parts built by another builder are not kept", async () => {
    const first = await buildBusiness("t", "x", pages, [], "other", maker().llms, [], { concurrency: 3 });
    const m = maker();
    await buildBusiness("t", "x", pages, [], "test", m.llms, [], { concurrency: 3, prev: first });
    expect(new Set(m.state.calls)).toEqual(new Set(["a", "b", "c"]));
  }, 20000);
});

// With general terms: every part reads them, so every part has the order's delivery fee. Left alone, a part names it
// its own way ("oplata"); told the terms part's id, it uses that one.
describe("the items of the whole order", () => {
  const terms = [{ url: "https://x.pl/terms", text: "terms: delivery fee 19,5 " + "t ".repeat(500) }];
  const program = (ids: string[]) => "```js\nconst catalog = { business: 'x', currency: 'PLN', shared: [], items: [" + ids.map((id) => `{ id: '${id}', name: '${id}', inputs: [] }`).join(", ") + "] };\nfunction needs() { return []; }\nfunction quote(r) { return { lines: r.lines.map(function (l) { return { item: l.item, status: 'price', amount: 10 }; }), total: null, rules: [] }; }\n```";
  const maker = () => {
    const calls: string[] = [];
    const gen: Llm = async (_s, user) => {
      const n = /page-(\w)/.exec(user)?.[1] || "terms";
      calls.push(n);
      return program(n === "terms" ? ["fee"] : [n, /^- fee: /m.test(user) ? "fee" : "oplata"]);
    };
    return { calls, llms: { gen, check: (async () => '{"cases": []}') as Llm } };
  };
  const all = (pb: { parts: { catalog: { items: { id: string }[] } }[] }) => pb.parts.map((p) => p.catalog.items.map((i) => i.id).join("+"));

  it("come from a part of the terms alone, built first; every other part uses their ids", async () => {
    const m = maker();
    const pb = await buildBusiness("t", "x", pages, [], "test", m.llms, terms, { concurrency: 3 });
    expect(m.calls[0]).toBe("terms");
    expect(all(pb)).toEqual(["fee", "a+fee", "b+fee", "c+fee"]);
  }, 20000);

  it("a stored part that names an order item its own way is built again; the others are kept", async () => {
    const first = await buildBusiness("t", "x", pages, [], "test", maker().llms, terms, { concurrency: 3 });
    // As stored before the order items were recorded, one part with its own name for the fee.
    const old = { ...first, parts: first.parts.map((p, k) => { const { order, ...rest } = p; return k === 2 ? { ...rest, catalog: { ...p.catalog, items: [{ id: "b", name: "b", inputs: [] }, { id: "oplata", name: "oplata", inputs: [] }] } } : rest; }) };
    const m = maker();
    const pb = await buildBusiness("t", "x", pages, [], "test", m.llms, terms, { concurrency: 3, prev: old });
    expect(new Set(m.calls)).toEqual(new Set(["b"]));
    expect(all(pb)).toEqual(["fee", "a+fee", "b+fee", "c+fee"]);
  }, 20000);
});

describe("a build that stops half-way", () => {
  it("has handed over every finished part, and a new build from those builds only the rest", async () => {
    const lost = maker("c");
    let kept: any[] = [];
    await buildBusiness("t", "x", pages, [], "test", lost.llms, [], { concurrency: 1, onPart: (_k, _of, how, soFar) => { if (how === "built") kept = soFar; } });
    expect(kept.map((p) => p.catalog.items[0].id)).toEqual(["a", "b"]);
    const m = maker();
    const pb = await buildBusiness("t", "x", pages, [], "test", m.llms, [], { prev: { tenantId: "t", hash: "", builtAt: "", model: "", costUsd: 0, missing: [], parts: kept } });
    expect(ids(pb)).toEqual(["a", "b", "c"]);
    expect(new Set(m.state.calls)).toEqual(new Set(["c"]));
  }, 20000);
});
