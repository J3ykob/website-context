import { describe, it, expect, vi } from "vitest";

// No page count decides what a crawl reads (owner, 2026-11-14: a 500-page ceiling cut a cake shop's 691
// pages and the cake a customer asked about was among the unread). A site of 620 product pages and 200
// tag listings, no sitemap: every product page is read, and from 300 pages on each further address is
// judged first, so the listings are not fetched.
let slow = 0;
vi.mock("../src/scraper/safe-url.js", () => ({ safeFetch: async () => new Response("", { status: 404 }) }));
vi.mock("../src/scraper/fetcher.js", () => ({
  closeBrowser: async () => {},
  fetchPage: async (url: string) => {
    if (slow) await new Promise((r) => setTimeout(r, slow));
    const path = new URL(url).pathname;
    const links = path === "/"
      ? [...Array.from({ length: 620 }, (_, i) => `<a href="/produkt/tort-${i}">Tort ${i}</a>`), ...Array.from({ length: 200 }, (_, i) => `<a href="/tag/smak-${i}">Smak ${i}</a>`)].join(" ")
      : "";
    return { html: `<html><head><title>${path}</title></head><body><main><h1>Cukiernia ${path}</h1><p>${`Opis strony ${path}, zamówienia z dostawą. `.repeat(8)}</p>${links}</main></body></html>`, finalUrl: url, statusCode: 200, renderMethod: "static", headers: {} };
  },
}));

const judged: string[] = [];
const triage = async (cands: { url: string; text: string }[]) => { judged.push(...cands.map((c) => c.url)); return cands.map((c) => !new URL(c.url).pathname.startsWith("/tag/")); };
const base = { maxDepth: 2, rateLimit: 0, minGap: 0, concurrency: 12, respectRobotsTxt: false, triage };

describe("crawl without a page limit", () => {
  it("reads all 620 product pages; listings judged not worth reading are never fetched", async () => {
    const { crawlSite } = await import("../src/scraper/crawler.js");
    const r = await crawlSite("https://cukiernia.example/", base);
    const paths = r.pages.map((p) => new URL(p.url).pathname);
    expect(paths.filter((p) => p.startsWith("/produkt/")).length).toBe(620);
    expect(paths.filter((p) => p.startsWith("/tag/")).length).toBe(0);
    expect(judged.length).toBeGreaterThan(200); // the listings and the product pages still waiting at 300
    expect(r.stats.stoppedBy).toBeUndefined();
  }, 120000);

  it("a caller's page count still stops the crawl, and says how many addresses it left", async () => {
    const { crawlSite } = await import("../src/scraper/crawler.js");
    const r = await crawlSite("https://cukiernia.example/", { ...base, maxPages: 50 });
    expect(r.pages.length).toBe(50);
    expect(r.stats.stoppedBy).toBe("pages");
    expect(r.stats.leftUnread).toBeGreaterThan(500);
  }, 120000);

  it("the crawl's time stops it with the pages read so far", async () => {
    slow = 40;
    const { crawlSite } = await import("../src/scraper/crawler.js");
    const r = await crawlSite("https://cukiernia.example/", { ...base, maxTime: 600 });
    slow = 0;
    expect(r.pages.length).toBeGreaterThan(10);
    expect(r.pages.length).toBeLessThan(400);
    expect(r.stats.stoppedBy).toBe("time");
    expect(r.stats.leftUnread).toBeGreaterThan(200);
  }, 120000);
});
