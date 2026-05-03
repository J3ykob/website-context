import { describe, it, expect, afterAll } from "vitest";
import { crawlSite } from "../src/scraper/crawler.js";
import { closeBrowser } from "../src/scraper/fetcher.js";
import { buildContext } from "../src/context/store.js";
import { BGEEmbeddingProvider } from "../src/embeddings/bge-provider.js";
import { QdrantVectorStore } from "../src/embeddings/qdrant-store.js";
import { embedChunks, searchContext } from "../src/embeddings/pipeline.js";

const COLLECTION_NAME = "wctx_test_" + Date.now();

afterAll(async () => {
  await closeBrowser();
  // Clean up test collection
  try {
    await fetch(`http://152.53.243.28:6333/collections/${COLLECTION_NAME}`, {
      method: "DELETE",
    });
  } catch {}
});

describe("Self-hosted infrastructure (BGE + Qdrant)", () => {
  it("BGE embedding server responds correctly", async () => {
    const provider = new BGEEmbeddingProvider();

    const embeddings = await provider.embed(["Hello world", "How are you?"]);

    expect(embeddings.length).toBe(2);
    expect(embeddings[0].length).toBe(1024);
    expect(embeddings[1].length).toBe(1024);

    // Vectors should be different
    const diff = embeddings[0].reduce((s, v, i) => s + Math.abs(v - embeddings[1][i]), 0);
    expect(diff).toBeGreaterThan(0.1);

    console.log(`  BGE: 2 texts → 2 × 1024d vectors (diff=${diff.toFixed(3)})`);
  }, 10000);

  it("Qdrant creates collection and stores vectors", async () => {
    const store = new QdrantVectorStore({
      collection: COLLECTION_NAME,
      createIfMissing: true,
    });

    const testVector = new Array(1024).fill(0).map(() => Math.random() - 0.5);

    await store.upsert([
      { id: "test-1", vector: testVector, content: "test content", metadata: { type: "test" } },
    ]);

    const count = await store.count();
    expect(count).toBe(1);

    const results = await store.search(testVector, 1);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("test-1");
    expect(results[0].score).toBeGreaterThan(0.99);

    console.log(`  Qdrant: collection=${COLLECTION_NAME}, count=${count}, search_score=${results[0].score.toFixed(4)}`);
  }, 10000);

  it("full pipeline: scrape → embed with BGE → store in Qdrant → search", async () => {
    // Step 1: Crawl a small site
    const crawlResult = await crawlSite("https://example.com", {
      maxPages: 2,
      maxDepth: 1,
      rateLimit: 500,
    });
    expect(crawlResult.stats.successPages).toBeGreaterThanOrEqual(1);

    // Step 2: Build context
    const context = await buildContext(crawlResult);
    expect(context.chunks.length).toBeGreaterThan(0);

    // Step 3: Embed with BGE
    const provider = new BGEEmbeddingProvider();
    const store = new QdrantVectorStore({
      collection: COLLECTION_NAME,
      createIfMissing: true,
    });

    const embedResult = await embedChunks(context.chunks, provider, store);
    expect(embedResult.embeddedChunks).toBeGreaterThan(0);
    expect(embedResult.failedChunks).toBe(0);

    // Step 4: Search
    const results = await searchContext("What is this domain used for?", provider, store, {
      topK: 3,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0.3);

    console.log(`\n  Full pipeline results:`);
    console.log(`    Crawled: ${crawlResult.stats.successPages} pages`);
    console.log(`    Chunks: ${context.chunks.length}`);
    console.log(`    Embedded: ${embedResult.embeddedChunks} in ${embedResult.timeMs}ms`);
    console.log(`    Search results: ${results.length}`);
    results.forEach((r, i) => {
      console.log(`      ${i + 1}. score=${r.score.toFixed(3)} "${r.content.slice(0, 80)}..."`);
    });
  }, 60000);
});
