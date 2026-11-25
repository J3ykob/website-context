import { describe, it, expect, vi } from "vitest";

const files = new Map<string, string>();
vi.mock("../src/storage/r2.js", () => ({ downloadFromR2: async (key: string) => (files.has(key) ? Buffer.from(files.get(key)!) : null) }));
// Jev: the page of the offer is one, the blog post is not; `jev.down` = no answer.
const jev = { down: false };
vi.mock("../src/llm/jev.js", () => ({ jevAsk: async (state: { pages: string[] }) => (jev.down ? null : Object.fromEntries(state.pages.map((p, k) => [`o${k}`, { noul: p.includes("/blog/") ? 0.1 : 0.9 }]))) }));

// A make-up artist: the offer pages the scrape kept leave out her bridal page, where the package prices are.
const chunk = (catalogId: string, url: string, content: string) => ({ id: content.slice(0, 8), catalogId, url, content, title: "", type: "content" });
files.set("tenants/t/knowledge-catalog.json", JSON.stringify({ catalogs: [], chunks: [
  chunk("pricing", "https://x.pl/slub/", "Summary. Keywords: cena, price.\n\nPakiet Komfort 3000 zł"),
  chunk("services", "https://x.pl/slub/", "Makijaż ślubny w studiu lub z dojazdem"),
  chunk("reviews", "https://x.pl/slub/", "Polecam!"),
  chunk("pricing", "https://x.pl/kursy", "Kurs 900 zł"),
  chunk("pricing", "https://x.pl/blog/pedzle", "Pędzel 80 zł"),
  chunk("services", "https://x.pl/o-mnie", "Maluję od 10 lat"),
] }));
files.set("tenants/t/context-meta.json", JSON.stringify({ siteMap: [{ url: "https://x.pl/blog/pedzle", type: "article" }, { url: "https://x.pl/slub/", type: "page" }] }));

describe("priced pages the offer pages leave out", () => {
  it("are the pages with a pricing passage that are no offer page and that Jev reads as the offer, as their pricing and service text", async () => {
    const { pricedPages } = await import("../src/pricing/build-job.js");
    const more = await pricedPages("t", ["https://x.pl/kursy/"]);
    expect(more).toEqual([{ url: "https://x.pl/slub", text: "Summary.\n\nPakiet Komfort 3000 zł\n\nMakijaż ślubny w studiu lub z dojazdem" }]);
  });
  it("a page the site map calls a post is taken when Jev reads it as the offer; without Jev only the non-posts", async () => {
    const { pricedPages } = await import("../src/pricing/build-job.js");
    files.set("tenants/t/context-meta.json", JSON.stringify({ siteMap: [{ url: "https://x.pl/blog/pedzle", type: "article" }, { url: "https://x.pl/slub/", type: "article" }] }));
    expect((await pricedPages("t", ["https://x.pl/kursy"])).map((p) => p.url)).toEqual(["https://x.pl/slub"]);
    jev.down = true;
    expect(await pricedPages("t", ["https://x.pl/kursy"])).toEqual([]);
    jev.down = false;
  });
  it("go into the build after the offer pages and are not part of the model's hash", async () => {
    const { buildBusiness, pagesHash } = await import("../src/pricing/model.js");
    const seen: string[] = [];
    const gen = async (_s: string, user: string) => { seen.push(user); return "```js\nconst catalog = { business: 'x', currency: 'PLN', shared: [], items: [{ id: 'a', name: 'a', inputs: [] }] };\nfunction needs() { return []; }\nfunction quote(r) { return { lines: [], total: null, rules: [] }; }\n```"; };
    const offer = [{ url: "https://x.pl/kursy", text: "Kurs 900 zł" }];
    const pb = await buildBusiness("t", "x", offer, [], "test", { gen, check: async () => '{"cases": []}' }, [], { more: [{ url: "https://x.pl/slub", text: "Pakiet Komfort 3000 zł" }, offer[0]] });
    expect(seen[0]).toContain("Pakiet Komfort 3000 zł");
    expect(seen[0].indexOf("Kurs 900")).toBeLessThan(seen[0].indexOf("Pakiet Komfort"));
    expect(seen[0].match(/Kurs 900 zł/g)).toHaveLength(1);
    expect(pb.hash).toBe(pagesHash("test", offer));
  }, 20000);
});
