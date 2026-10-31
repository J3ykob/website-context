import { describe, it, expect } from "vitest";
import { run } from "../src/pricing/model.js";

// The quoting programs are written by a model from scraped pages: they run in QuickJS, never in our process.
const program = `
const catalog = { business: "Test", currency: "PLN", shared: [], items: [{ id: "a", name: "A", inputs: [{ name: "n", meaning: "count", type: "number" }] }] };
function needs(r) { return r.lines.filter((l) => l.inputs.n == null).map((l) => ({ item: l.item, missing: ["n"] })); }
function quote(r) { return { lines: r.lines.map((l) => l.inputs.n == null ? { item: l.item, status: "needs", needs: ["n"] } : { item: l.item, status: "price", amount: l.inputs.n * 205 }), total: null, rules: [] }; }`;

describe("pricing sandbox (QuickJS)", () => {
  it("runs the program's functions and its catalogue", async () => {
    expect((await run(program, "catalog", null)).items[0].id).toBe("a");
    expect((await run(program, "quote", { context: {}, lines: [{ item: "a", inputs: { n: 90 } }] })).lines[0].amount).toBe(18450);
    expect(await run(program, "needs", { context: {}, lines: [{ item: "a", inputs: {} }] })).toEqual([{ item: "a", missing: ["n"] }]);
  });
  it("has nothing of our process: no require, process, fetch, globalThis.process", async () => {
    for (const probe of ["require('fs')", "process.env", "fetch('https://example.com')"]) {
      await expect(run(`const catalog = {}; function quote() { return ${probe}; }`, "quote", {})).rejects.toThrow();
    }
    expect(await run(`const catalog = {}; function quote() { return typeof process + typeof require + typeof fetch; }`, "quote", {})).toBe("undefinedundefinedundefined");
  });
  it("stops a program that never ends, and one that eats memory", async () => {
    await expect(run(`const catalog = {}; function quote() { for (;;) {} }`, "quote", {}, 100)).rejects.toThrow();
    await expect(run(`const catalog = {}; function quote() { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }`, "quote", {}, 2000)).rejects.toThrow();
  });
});
