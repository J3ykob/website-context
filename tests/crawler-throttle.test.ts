import { describe, it, expect, vi } from "vitest";

// A site that answers 429 to any request within 300 ms of the previous one (kwiaciarniamilosc.pl
// throttled our 6 parallel workers for half an hour): after the first 429 the crawl must slow down to one
// request at a time and finish, not retry in bursts until every page fails.
let last = 0, ok = 0, throttled = 0, blockAll = false;
vi.mock("../src/scraper/safe-url.js", () => ({ safeFetch: async () => new Response("", { status: 404 }) }));
vi.mock("../src/scraper/fetcher.js", () => ({
  closeBrowser: async () => {},
  fetchPage: async (url: string) => {
    const now = Date.now();
    if ((blockAll && new URL(url).pathname !== "/") || now - last < 300) { throttled++; return { html: "", finalUrl: url, statusCode: 429, renderMethod: "static", headers: {} }; }
    last = now; ok++;
    const n = Number(new URL(url).pathname.replace(/\D/g, "") || 99);
    const links = Array.from({ length: blockAll ? 40 : 12 }, (_, i) => `<a href="/p${i}">Strona ${i}</a>`).join(" ");
    return { html: `<html><head><title>Strona ${n}</title></head><body><main><h1>Kwiaty ${n}</h1><p>${"Bukiet róż na wesele i dekoracje sali, dostawa po Warszawie. ".repeat(10 + n)}</p>${links}</main></body></html>`, finalUrl: url, statusCode: 200, renderMethod: "static", headers: { "content-type": "text/html" } };
  },
}));

describe("crawl politeness", () => {
  it("paced by default: requests start at least ~0.5 s apart, so a site with a 300 ms limit never throttles", async () => {
    const { crawlSite } = await import("../src/scraper/crawler.js");
    const t0 = Date.now();
    const r = await crawlSite("https://spokojnie.example/", { maxPages: 7, maxDepth: 2, rateLimit: 0, concurrency: 12, respectRobotsTxt: false });
    expect(r.pages.length).toBe(7);
    expect(throttled).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(6 * 480);
    last = 0; ok = 0; throttled = 0;
  }, 60000);

  it("a throttling site: one request at a time after the first 429, every page read", async () => {
    const { crawlSite } = await import("../src/scraper/crawler.js");
    const r = await crawlSite("https://kwiaty.example/", { maxPages: 13, maxDepth: 2, rateLimit: 0, minGap: 0, respectRobotsTxt: false });
    expect(r.pages.length).toBe(13);
    expect(throttled).toBeLessThan(15);
  }, 60000);

  it("a site that throttles everything: given up after 12 throttles in a row, not held", async () => {
    blockAll = true; throttled = 0;
    const { crawlSite } = await import("../src/scraper/crawler.js");
    const r = await crawlSite("https://blocked.example/", { maxPages: 50, maxDepth: 2, rateLimit: 0, minGap: 0, respectRobotsTxt: false });
    expect(r.pages.length).toBe(1);
    expect(throttled).toBeLessThan(20);
  }, 400000);
});
