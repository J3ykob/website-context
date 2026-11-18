import { describe, it, expect } from "vitest";
import { buildPackIndex, candidatePacks } from "../src/llm/packs.js";

// A site of `n` pages, one passage each; the owner's typed entry is a search hit the catalog doesn't know.
const site = (n: number) => buildPackIndex({
  catalogs: [{ id: "offer", name: "Offer" }],
  chunks: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, catalogId: "offer", content: `page ${i} text`, url: `https://x.pl/p${i}`, title: `Page ${i}`, type: "content" })),
} as any)!;
const pageHit = (i: number) => ({ metadata: { id: `c${i}`, url: `https://x.pl/p${i}` } });
const typed = (id: string, title: string, content: string) => ({ content, metadata: { id, url: "", title, type: "manual" } });

describe("candidate packs: what the owner typed in the panel", () => {
  it("a small site: the typed entry is a candidate next to every page (it was left out)", () => {
    const c = candidatePacks(site(5), [pageHit(2), typed("manual_1", "wyceny", "wyceny indywidualnie, cena wstępna 500 zł")]);
    expect(c.find((p) => p.title === "wyceny")?.chunks[0].content).toContain("500 zł");
    expect(c.filter((p) => p.id.startsWith("page:"))).toHaveLength(5);
  });
  it("a large site: the same", () => {
    const c = candidatePacks(site(30), [pageHit(2), typed("manual_1", "wyceny", "cena wstępna 500 zł")]);
    expect(c.some((p) => p.title === "wyceny")).toBe(true);
  });
  it("two typed entries are two candidates, each with its own title", () => {
    const c = candidatePacks(site(5), [typed("manual_1", "wyceny", "500 zł"), typed("manual_2", "dojazd", "do 50 km w cenie")]);
    expect(c.filter((p) => p.id.startsWith("hit:")).map((p) => p.title)).toEqual(["wyceny", "dojazd"]);
  });
});
