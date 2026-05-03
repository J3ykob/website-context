import { describe, it, expect, afterAll } from "vitest";
import { crawlSite } from "../src/scraper/crawler.js";
import { closeBrowser } from "../src/scraper/fetcher.js";
import { buildContext } from "../src/context/store.js";

afterAll(async () => {
  await closeBrowser();
});

describe("Context Store - End to End", () => {
  it("builds structured context from a crawled site", async () => {
    // Crawl a real site
    const crawlResult = await crawlSite("https://vite.dev", {
      maxPages: 3,
      maxDepth: 2,
      rateLimit: 800,
    });

    expect(crawlResult.pages.length).toBeGreaterThanOrEqual(1);

    // Build context from crawl result
    const context = await buildContext(crawlResult);

    // Validate structure
    expect(context.pages.length).toBeGreaterThanOrEqual(1);
    expect(context.chunks.length).toBeGreaterThan(0);
    expect(context.siteMap.length).toBeGreaterThanOrEqual(1);

    // Validate page structure
    for (const page of context.pages) {
      expect(page.id).toBeTruthy();
      expect(page.url).toMatch(/^https?:\/\//);
      expect(page.title).toBeTruthy();
      expect(page.contentHash).toBeTruthy();
    }

    // Validate chunks
    for (const chunk of context.chunks) {
      expect(chunk.id).toBeTruthy();
      expect(chunk.pageId).toBeTruthy();
      expect(chunk.content.length).toBeGreaterThan(20);
      expect(chunk.metadata.url).toBeTruthy();
      expect(chunk.metadata.headingHierarchy).toBeDefined();
    }

    // Chunks should be reasonable size (not too big for LLM context)
    const avgChunkSize = context.chunks.reduce((s, c) => s + c.content.length, 0) / context.chunks.length;
    expect(avgChunkSize).toBeLessThan(2000);
    expect(avgChunkSize).toBeGreaterThan(50);

    console.log("\n--- Context Summary ---");
    console.log(`Pages: ${context.pages.length}`);
    console.log(`Chunks: ${context.chunks.length}`);
    console.log(`Avg chunk size: ${Math.round(avgChunkSize)} chars`);
    console.log(`Site map entries: ${context.siteMap.length}`);
    console.log("\nChunk types:", Object.entries(
      context.chunks.reduce((acc, c) => {
        acc[c.metadata.type] = (acc[c.metadata.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)
    ).map(([k, v]) => `${k}=${v}`).join(", "));
    console.log("\nFirst 3 chunks:");
    context.chunks.slice(0, 3).forEach((c, i) => {
      console.log(`  ${i + 1}. [${c.metadata.type}] ${c.content.slice(0, 100)}...`);
    });
  }, 60000);
});
