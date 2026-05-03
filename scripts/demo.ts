import { crawlSite, closeBrowser } from "../src/scraper/index.js";
import { buildContext } from "../src/context/index.js";
import { InMemoryVectorStore } from "../src/embeddings/memory-store.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";
import { embedChunks, searchContext } from "../src/embeddings/pipeline.js";

// Simple TF-IDF-like embedding for demo (no API key needed)
class SimpleEmbeddingProvider implements EmbeddingProvider {
  dimensions = 100;
  modelName = "simple-tfidf-demo";

  private vocabulary: Map<string, number> = new Map();

  async embed(texts: string[]): Promise<number[][]> {
    // Build vocabulary from all texts
    for (const text of texts) {
      for (const word of this.tokenize(text)) {
        if (!this.vocabulary.has(word)) {
          this.vocabulary.set(word, this.vocabulary.size % this.dimensions);
        }
      }
    }

    return texts.map((text) => this.embedSingle(text));
  }

  private embedSingle(text: string): number[] {
    const vector = new Array(this.dimensions).fill(0);
    const words = this.tokenize(text);
    for (const word of words) {
      const idx = this.vocabulary.get(word) ?? (word.charCodeAt(0) % this.dimensions);
      vector[idx] += 1;
    }
    // Normalize
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    }
    return vector;
  }

  private tokenize(text: string): string[] {
    return text.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  }
}

async function main() {
  const url = process.argv[2] || "https://vite.dev";
  const maxPages = parseInt(process.argv[3] || "5");
  const query = process.argv[4] || "How do I get started?";

  console.log("╔════════════════════════════════════════════════╗");
  console.log("║   Website Context — Full Pipeline Demo         ║");
  console.log("╚════════════════════════════════════════════════╝\n");

  // Step 1: Crawl
  console.log(`➤ Step 1: Crawling ${url} (max ${maxPages} pages)...\n`);
  const crawlResult = await crawlSite(url, { maxPages, maxDepth: 2, rateLimit: 800 });
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

  // Step 3: Embed
  console.log("➤ Step 3: Generating embeddings...\n");
  const provider = new SimpleEmbeddingProvider();
  const store = new InMemoryVectorStore();
  const embedResult = await embedChunks(context.chunks, provider, store);
  console.log(`  ✓ Embedded ${embedResult.embeddedChunks} chunks in ${embedResult.timeMs}ms\n`);

  // Step 4: Search
  console.log(`➤ Step 4: Searching for: "${query}"\n`);
  const results = await searchContext(query, provider, store, { topK: 3 });
  console.log("  Results:");
  results.forEach((r, i) => {
    console.log(`\n  [${i + 1}] Score: ${r.score.toFixed(3)}`);
    console.log(`      Source: ${r.metadata.title}`);
    console.log(`      Path: ${(r.metadata.headingHierarchy as string[])?.join(" > ") || "—"}`);
    console.log(`      Content: ${r.content.slice(0, 200).replace(/\n/g, " ")}...`);
  });

  console.log("\n\n═══════════════════════════════════════════════════");
  console.log("Pipeline complete! With OPENAI_API_KEY set, the embeddings");
  console.log("would use OpenAI text-embedding-3-small for much better search.");
  console.log("With ANTHROPIC_API_KEY, the chat would use Claude for answers.");
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch(console.error);
