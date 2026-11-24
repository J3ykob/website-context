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
