import { crawlSite, closeBrowser } from "../src/scraper/index.js";
import { buildContext } from "../src/context/index.js";
import { BGEEmbeddingProvider } from "../src/embeddings/bge-provider.js";
import { QdrantVectorStore } from "../src/embeddings/qdrant-store.js";
import { embedChunks } from "../src/embeddings/pipeline.js";
import { WebsiteChat } from "../src/llm/chat.js";

async function main() {
  const url = process.argv[2] || "https://vite.dev";
  const maxPages = parseInt(process.argv[3] || "4");
  const question = process.argv[4] || "How do I create a new project with Vite?";
  const collection = `wctx_e2e_${Date.now()}`;

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Website Context — Full E2E (BGE + Qdrant + Claude CLI) ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // Step 1: Crawl
  console.log(`➤ Crawling ${url} (${maxPages} pages)...`);
  const crawlResult = await crawlSite(url, { maxPages, maxDepth: 2, rateLimit: 800 });
  await closeBrowser();
  console.log(`  ✓ ${crawlResult.stats.successPages} pages in ${crawlResult.stats.totalTime}ms\n`);

  // Step 2: Context
  console.log("➤ Building context...");
  const context = await buildContext(crawlResult);
  await closeBrowser();
  console.log(`  ✓ ${context.chunks.length} chunks\n`);

  // Step 3: Embed
  console.log("➤ Embedding with BGE (GPU server)...");
  const provider = new BGEEmbeddingProvider();
  const store = new QdrantVectorStore({ collection, createIfMissing: true });
  const embedResult = await embedChunks(context.chunks, provider, store);
  console.log(`  ✓ ${embedResult.embeddedChunks} chunks in ${embedResult.timeMs}ms\n`);

  // Step 4: Chat with Claude CLI
  console.log(`➤ Asking: "${question}"\n`);
  const chat = new WebsiteChat(provider, store, context, {
    llmProvider: "claude-cli",
    claudeCli: { mode: "local", model: "sonnet" },
  });

  const response = await chat.chat([{ role: "user", content: question }]);

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("ANSWER:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(response.message);
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Sources:", response.sources.map((s) => s.title).join(", "));
  if (response.suggestedAction) {
    console.log("Suggested action:", response.suggestedAction.flowName);
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Cleanup
  await fetch(`http://152.53.243.28:6333/collections/${collection}`, { method: "DELETE" });
  console.log("✓ Cleaned up Qdrant collection\n");
}

main().catch(console.error);
