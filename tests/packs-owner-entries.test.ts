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

describe("candidate packs: the general topics on a large site", () => {
  // A shop: 30 product pages, one long terms page, a contact topic small enough to be one pack.
  const shop = (termsChars: number) => buildPackIndex({
    catalogs: [{ id: "products", name: "Products" }, { id: "policies", name: "Terms" }, { id: "contact", name: "Contact" }],
    chunks: [
      ...Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, catalogId: "products", content: `cake ${i}, delivery, price`, url: `https://x.pl/p${i}`, title: `Cake ${i}`, type: "content" })),
      { id: "t1", catalogId: "policies", content: "delivery costs 19,5 zł ".repeat(Math.ceil(termsChars / 23)), url: "https://x.pl/terms", title: "Privacy policy", type: "content" },
      { id: "t2", catalogId: "policies", content: "returns: see the terms", url: "https://x.pl/p3", title: "Cake 3", type: "content" },
      { id: "k1", catalogId: "contact", content: "tel. 22 000 00 00", url: "https://x.pl/contact", title: "Contact", type: "content" },
    ],
  } as any)!;
  const products = Array.from({ length: 20 }, (_, i) => pageHit(i));

  it("a terms page too long for a topic pack is still a candidate when the search returned only products", () => {
    const c = candidatePacks(shop(12000), products);
    expect(c.some((p) => p.url === "https://x.pl/terms")).toBe(true);
    expect(c.some((p) => p.id === "topic:contact")).toBe(true);
    expect(c.filter((p) => p.catalogs.includes("products") && !p.catalogs.includes("policies"))).toHaveLength(13);
  });
  it("short terms come as the topic pack, as before", () => {
    const c = candidatePacks(shop(500), products);
    expect(c.some((p) => p.id === "topic:policies")).toBe(true);
  });
});
