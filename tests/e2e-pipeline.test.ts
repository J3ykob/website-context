import { describe, it, expect, afterAll } from "vitest";
import { crawlSite } from "../src/scraper/crawler.js";
import { closeBrowser } from "../src/scraper/fetcher.js";
import { buildContext } from "../src/context/store.js";
import { InMemoryVectorStore } from "../src/embeddings/memory-store.js";
import { embedChunks, searchContext } from "../src/embeddings/pipeline.js";
import { OpenAIEmbeddingProvider } from "../src/embeddings/openai-provider.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";

afterAll(async () => {
  await closeBrowser();
});

const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

describe("Full Pipeline - Scrape → Context → Embed → Search", () => {
  it("builds complete context from a real website", async () => {
    // Step 1: Crawl
    const crawlResult = await crawlSite("https://vite.dev", {
      maxPages: 5,
      maxDepth: 2,
      rateLimit: 800,
    });
    expect(crawlResult.stats.successPages).toBeGreaterThanOrEqual(1);
    console.log(`  Crawled: ${crawlResult.stats.successPages} pages`);

    // Step 2: Build context
    const context = await buildContext(crawlResult);
    expect(context.chunks.length).toBeGreaterThan(5);
    console.log(`  Context: ${context.chunks.length} chunks, ${context.pages.length} pages`);

    // Validate chunk quality
    const avgChunkLength =
      context.chunks.reduce((s, c) => s + c.content.length, 0) / context.chunks.length;
    expect(avgChunkLength).toBeGreaterThan(50);
    expect(avgChunkLength).toBeLessThan(2000);
    console.log(`  Avg chunk: ${Math.round(avgChunkLength)} chars`);

    // Validate all chunks have metadata
    for (const chunk of context.chunks) {
      expect(chunk.metadata.url).toBeTruthy();
      expect(chunk.metadata.title).toBeTruthy();
      expect(chunk.metadata.type).toBeTruthy();
    }
  }, 60000);

  it.skipIf(!hasOpenAIKey)("embeds and searches context with OpenAI", async () => {
    // Step 1: Crawl + Context (smaller for API test)
    const crawlResult = await crawlSite("https://example.com", {
      maxPages: 2,
      maxDepth: 1,
      rateLimit: 500,
    });
    const context = await buildContext(crawlResult);

    // Step 2: Embed
    const provider = new OpenAIEmbeddingProvider({ provider: "openai" });
    const store = new InMemoryVectorStore();

    const embedResult = await embedChunks(context.chunks, provider, store);
    expect(embedResult.embeddedChunks).toBeGreaterThan(0);
    expect(embedResult.failedChunks).toBe(0);
    console.log(`  Embedded: ${embedResult.embeddedChunks} chunks in ${embedResult.timeMs}ms`);

    // Step 3: Search
    const results = await searchContext("What is this website about?", provider, store, {
      topK: 3,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
    console.log(`  Search results: ${results.length}`);
    results.forEach((r, i) => {
      console.log(`    ${i + 1}. score=${r.score.toFixed(3)} content="${r.content.slice(0, 80)}..."`);
    });
  }, 60000);
});

describe("Vector Store - Unit Tests", () => {
  it("stores and retrieves vectors correctly", async () => {
    const store = new InMemoryVectorStore();

    // Insert some test vectors
    await store.upsert([
      { id: "1", vector: [1, 0, 0], content: "about cats", metadata: { type: "content" } },
      { id: "2", vector: [0, 1, 0], content: "about dogs", metadata: { type: "content" } },
      { id: "3", vector: [0, 0, 1], content: "about birds", metadata: { type: "faq" } },
    ]);

    expect(await store.count()).toBe(3);

    // Search — should find closest vector
    const results = await store.search([0.9, 0.1, 0], 2);
    expect(results[0].id).toBe("1");
    expect(results[0].content).toBe("about cats");
    expect(results[0].score).toBeGreaterThan(0.9);

    // Search with filter
    const filteredResults = await store.search([0, 0, 1], 3, { type: "faq" });
    expect(filteredResults.length).toBe(1);
    expect(filteredResults[0].id).toBe("3");
  });

  it("handles upsert (update existing)", async () => {
    const store = new InMemoryVectorStore();

    await store.upsert([
      { id: "1", vector: [1, 0, 0], content: "original", metadata: {} },
    ]);
    await store.upsert([
      { id: "1", vector: [0, 1, 0], content: "updated", metadata: {} },
    ]);

    expect(await store.count()).toBe(1);
    const results = await store.search([0, 1, 0], 1);
    expect(results[0].content).toBe("updated");
  });

  it("deletes entries", async () => {
    const store = new InMemoryVectorStore();

    await store.upsert([
      { id: "1", vector: [1, 0, 0], content: "a", metadata: {} },
      { id: "2", vector: [0, 1, 0], content: "b", metadata: {} },
    ]);
    expect(await store.count()).toBe(2);

    await store.delete(["1"]);
    expect(await store.count()).toBe(1);

    const results = await store.search([1, 0, 0], 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("2");
  });
});
