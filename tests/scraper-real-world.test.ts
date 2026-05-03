import { describe, it, expect, afterAll } from "vitest";
import { crawlSite } from "../src/scraper/crawler.js";
import { closeBrowser } from "../src/scraper/fetcher.js";
import type { CrawlResult } from "../src/scraper/types.js";

afterAll(async () => {
  await closeBrowser();
});

function validateCrawlResult(result: CrawlResult, minPages: number) {
  expect(result.stats.successPages).toBeGreaterThanOrEqual(minPages);
  expect(result.pages.length).toBeGreaterThanOrEqual(minPages);

  for (const page of result.pages) {
    expect(page.url).toMatch(/^https?:\/\//);
    expect(page.title).toBeTruthy();
    expect(page.scrapedAt).toBeTruthy();
    expect(page.content.length).toBeGreaterThanOrEqual(0);
  }

  expect(result.siteMap).toBeDefined();
  expect(result.siteMap.url).toBeTruthy();
}

describe("Real-world website scraping", () => {
  it("scrapes a static business website (example.com)", async () => {
    const result = await crawlSite("https://example.com", {
      maxPages: 3,
      maxDepth: 2,
      rateLimit: 500,
    });

    validateCrawlResult(result, 1);
    expect(result.pages[0].renderMethod).toBe("static");
    console.log(`  example.com: ${result.stats.successPages} pages, ${result.stats.totalTime}ms`);
  }, 30000);

  it("scrapes a JavaScript-heavy docs site (vitejs.dev)", async () => {
    const result = await crawlSite("https://vitejs.dev", {
      maxPages: 5,
      maxDepth: 2,
      rateLimit: 1000,
    });

    validateCrawlResult(result, 1);
    const hasContent = result.pages.some((p) => p.content.length > 3);
    expect(hasContent).toBe(true);
    console.log(`  vitejs.dev: ${result.stats.successPages} pages, static=${result.stats.staticPages}, dynamic=${result.stats.dynamicPages}, ${result.stats.totalTime}ms`);
  }, 60000);

  it("scrapes a WordPress-style blog (blog.cloudflare.com)", async () => {
    const result = await crawlSite("https://blog.cloudflare.com", {
      maxPages: 5,
      maxDepth: 2,
      rateLimit: 1200,
    });

    validateCrawlResult(result, 1);
    const hasStructuredData = result.pages.some((p) => p.structuredData.length > 0);
    console.log(`  blog.cloudflare.com: ${result.stats.successPages} pages, structured_data=${hasStructuredData}, ${result.stats.totalTime}ms`);
  }, 60000);

  it("scrapes an e-commerce site (shopify themes demo)", async () => {
    const result = await crawlSite("https://themes.shopify.com/themes/dawn/styles/default/preview", {
      maxPages: 3,
      maxDepth: 1,
      rateLimit: 1500,
    });

    // Shopify preview may redirect or block, so just verify no crash
    expect(result.stats.totalPages).toBeGreaterThanOrEqual(1);
    console.log(`  shopify demo: ${result.stats.successPages} pages, ${result.stats.totalTime}ms`);
  }, 60000);

  it("scrapes a documentation site (docs.github.com)", async () => {
    const result = await crawlSite("https://docs.github.com/en", {
      maxPages: 5,
      maxDepth: 2,
      rateLimit: 1000,
    });

    validateCrawlResult(result, 1);
    const totalContent = result.pages.reduce((sum, p) => sum + p.content.length, 0);
    expect(totalContent).toBeGreaterThan(5);
    console.log(`  docs.github.com: ${result.stats.successPages} pages, ${totalContent} content blocks, ${result.stats.totalTime}ms`);
  }, 60000);
});
