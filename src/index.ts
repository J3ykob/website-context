import { crawlSite, closeBrowser } from "./scraper/index.js";
import { buildContext } from "./context/index.js";
import { BGEEmbeddingProvider, QdrantVectorStore, embedChunks } from "./embeddings/index.js";
import { WebsiteChat } from "./llm/index.js";
import type { CrawlOptions } from "./scraper/types.js";
import type { ChatConfig } from "./llm/chat.js";
import type { BGEProviderConfig } from "./embeddings/bge-provider.js";
import type { QdrantConfig } from "./embeddings/qdrant-store.js";

export interface WebsiteContextConfig {
  url: string;
  tenantId?: string;
  crawl?: CrawlOptions;
  embedding?: BGEProviderConfig;
  vectorStore?: Omit<QdrantConfig, "collection">;
  chat: ChatConfig;
}

export interface WebsiteContextInstance {
  chat: WebsiteChat;
  context: Awaited<ReturnType<typeof buildContext>>;
  stats: {
    pagesCrawled: number;
    chunksCreated: number;
    chunksEmbedded: number;
    totalTimeMs: number;
  };
}

export async function createWebsiteContext(
  config: WebsiteContextConfig
): Promise<WebsiteContextInstance> {
  const startTime = Date.now();
  const tenantId = config.tenantId || "default";

  console.log(`[website-context] Crawling ${config.url}...`);
  const crawlResult = await crawlSite(config.url, {
    maxPages: 30,
    maxDepth: 3,
    rateLimit: 800,
    ...config.crawl,
  });
  await closeBrowser();

  console.log(`[website-context] Building context (${crawlResult.stats.successPages} pages)...`);
  const context = await buildContext(crawlResult);
  context.tenantId = tenantId;
  await closeBrowser();

  console.log(`[website-context] Generating embeddings (${context.chunks.length} chunks)...`);
  const embeddingProvider = new BGEEmbeddingProvider(config.embedding);
  const vectorStore = new QdrantVectorStore({
    ...config.vectorStore,
    collection: `wctx_${tenantId}`,
    createIfMissing: true,
  });

  const embedResult = await embedChunks(context.chunks, embeddingProvider, vectorStore, {
    onProgress: (done, total) => {
      if (done % 50 === 0 || done === total) {
        console.log(`[website-context] Embedded ${done}/${total} chunks`);
      }
    },
  });

  console.log(`[website-context] Creating chat interface...`);
  const chat = new WebsiteChat(embeddingProvider, vectorStore, context, config.chat);

  const totalTimeMs = Date.now() - startTime;
  console.log(`[website-context] Ready! (${totalTimeMs}ms)`);

  return {
    chat,
    context,
    stats: {
      pagesCrawled: crawlResult.stats.successPages,
      chunksCreated: context.chunks.length,
      chunksEmbedded: embedResult.embeddedChunks,
      totalTimeMs,
    },
  };
}

// Re-export modules
export { crawlSite, closeBrowser } from "./scraper/index.js";
export { buildContext } from "./context/index.js";
export { BGEEmbeddingProvider, QdrantVectorStore, InMemoryVectorStore, embedChunks, searchContext } from "./embeddings/index.js";
export { OpenAIEmbeddingProvider } from "./embeddings/openai-provider.js";
export { WebsiteChat, VLLMProvider } from "./llm/index.js";
export type { ChatMessage, ChatConfig, ChatResponse } from "./llm/chat.js";
export type { VLLMConfig } from "./llm/vllm-provider.js";
export type { CrawlResult, CrawlOptions, ScrapedPage } from "./scraper/types.js";
export type { WebsiteContext, FlowDefinition, ContentChunk } from "./context/types.js";
export type { BGEProviderConfig } from "./embeddings/bge-provider.js";
export type { QdrantConfig } from "./embeddings/qdrant-store.js";
