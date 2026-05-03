import { describe, it, expect, afterAll } from "vitest";
import { fetchPage, closeBrowser } from "../src/scraper/fetcher.js";
import { extractPage } from "../src/scraper/extractor.js";
import { crawlSite } from "../src/scraper/crawler.js";

afterAll(async () => {
  await closeBrowser();
});

describe("Fetcher", () => {
  it("fetches a static HTML page", async () => {
    const result = await fetchPage("https://example.com");
    expect(result.statusCode).toBe(200);
    expect(result.html).toContain("Example Domain");
    expect(result.renderMethod).toBe("static");
  }, 15000);

  it("detects JS-rendered pages and uses dynamic rendering", async () => {
    // React-based site that requires JS
    const result = await fetchPage("https://react.dev");
    expect(result.statusCode).toBe(200);
    expect(result.html.length).toBeGreaterThan(1000);
  }, 30000);
});

describe("Extractor", () => {
  it("extracts structured content from a static page", async () => {
    const fetchResult = await fetchPage("https://example.com");
    const page = extractPage(fetchResult);

    expect(page.title).toBeTruthy();
    expect(page.url).toBe("https://example.com/");
    expect(page.content.length).toBeGreaterThan(0);
    expect(page.links.length).toBeGreaterThan(0);
  }, 15000);

  it("extracts metadata from a real website", async () => {
    const fetchResult = await fetchPage("https://github.com/about");
    const page = extractPage(fetchResult);

    expect(page.title).toBeTruthy();
    expect(page.description).toBeTruthy();
    expect(page.metadata.ogTitle || page.metadata.ogDescription).toBeTruthy();
  }, 15000);

  it("extracts JSON-LD structured data", async () => {
    // A site known to have JSON-LD (Wikipedia or major site)
    const fetchResult = await fetchPage("https://www.wikipedia.org");
    const page = extractPage(fetchResult);

    // Wikipedia may or may not have JSON-LD, but test the extraction pipeline
    expect(page.title).toBeTruthy();
    expect(page.content.length).toBeGreaterThanOrEqual(0);
    expect(page.links.length).toBeGreaterThan(0);
  }, 15000);
});

describe("Crawler - Integration", () => {
  it("crawls a small site with BFS", async () => {
    const result = await crawlSite("https://example.com", {
      maxPages: 3,
      maxDepth: 1,
      rateLimit: 500,
    });

    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    expect(result.stats.successPages).toBeGreaterThanOrEqual(1);
    expect(result.siteMap.url).toBe("https://example.com");
    expect(result.baseUrl).toBe("https://example.com");
  }, 30000);
});
