import { crawlSite, closeBrowser } from "../src/scraper/index.js";
import { buildContext } from "../src/context/index.js";
import { BGEEmbeddingProvider } from "../src/embeddings/bge-provider.js";
import { QdrantVectorStore } from "../src/embeddings/qdrant-store.js";
import { embedChunks, searchContext } from "../src/embeddings/pipeline.js";

async function main() {
  const url = process.argv[2] || "https://vite.dev";
  const maxPages = parseInt(process.argv[3] || "5");
  const query = process.argv[4] || "How do I get started?";
  const collection = `wctx_demo_${Date.now()}`;

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   Website Context — Self-Hosted Pipeline Demo        ║");
  console.log("║   BGE @ 176.9.1.133:7900 + Qdrant @ 152.53.243.28   ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // Step 1: Crawl
  console.log(`➤ Step 1: Crawling ${url} (max ${maxPages} pages)...\n`);
  const crawlResult = await crawlSite(url, { maxPages, maxDepth: 2, rateLimit: 800 });
  await closeBrowser();
  console.log(`  ✓ Crawled ${crawlResult.stats.successPages} pages in ${crawlResult.stats.totalTime}ms\n`);

  // Step 2: Build context
  console.log("➤ Step 2: Building structured context...\n");
  const context = await buildContext(crawlResult);
  await closeBrowser();
  console.log(`  ✓ ${context.pages.length} pages, ${context.chunks.length} chunks`);
  console.log(`  ✓ Site map:`);
  context.siteMap.slice(0, 8).forEach((entry) => {
    console.log(`    ${"  ".repeat(entry.depth)}${entry.title} (${entry.type})`);
  });
  console.log("");

  // Step 3: Embed with BGE on GPU server
  console.log("➤ Step 3: Embedding with BGE-large-en-v1.5 (GPU server)...\n");
  const provider = new BGEEmbeddingProvider();
  const store = new QdrantVectorStore({ collection, createIfMissing: true });

  const embedResult = await embedChunks(context.chunks, provider, store);
  console.log(`  ✓ Embedded ${embedResult.embeddedChunks} chunks in ${embedResult.timeMs}ms`);
  console.log(`  ✓ Stored in Qdrant collection: ${collection}\n`);

  // Step 4: Search
  console.log(`➤ Step 4: Searching: "${query}"\n`);
  const results = await searchContext(query, provider, store, { topK: 5 });
  console.log("  Results (ranked by cosine similarity):");
  results.forEach((r, i) => {
    console.log(`\n  [${i + 1}] Score: ${r.score.toFixed(4)}`);
    console.log(`      Source: ${r.metadata.title}`);
    console.log(`      Path: ${(r.metadata.headingHierarchy as string[])?.join(" > ") || "—"}`);
    console.log(`      Content: ${r.content.slice(0, 200).replace(/\n/g, " ")}...`);
  });

  // Cleanup
  console.log(`\n\n➤ Cleaning up Qdrant collection: ${collection}`);
  await fetch(`http://152.53.243.28:6333/collections/${collection}`, { method: "DELETE" });
  console.log("  ✓ Done\n");

  console.log("═══════════════════════════════════════════════════════");
  console.log("Pipeline complete using self-hosted infrastructure only!");
  console.log("No OpenAI/Anthropic API keys needed.");
  console.log("For LLM chat: deploy vLLM with Qwen2.5-7B on the GPU server.");
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);
