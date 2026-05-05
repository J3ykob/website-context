import type { ContentChunk } from "../context/types.js";
import type { EmbeddingProvider, VectorStore, VectorEntry } from "./types.js";

export interface EmbeddingPipelineResult {
  totalChunks: number;
  embeddedChunks: number;
  failedChunks: number;
  timeMs: number;
}

export async function embedChunks(
  chunks: ContentChunk[],
  provider: EmbeddingProvider,
  store: VectorStore,
  options: { batchSize?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<EmbeddingPipelineResult> {
  const { batchSize = 50, onProgress } = options;
  const startTime = Date.now();
  let embeddedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((chunk) => prepareChunkForEmbedding(chunk));

    try {
      const embeddings = await provider.embed(texts);

      const entries: VectorEntry[] = batch.map((chunk, idx) => ({
        id: chunk.id,
        vector: embeddings[idx],
        content: chunk.content,
        metadata: {
          pageId: chunk.pageId,
          url: chunk.metadata.url,
          title: chunk.metadata.title,
          type: chunk.metadata.type,
          headingHierarchy: chunk.metadata.headingHierarchy,
        },
      }));

      await store.upsert(entries);
      embeddedCount += batch.length;
    } catch (error) {
      console.error(`Failed to embed batch starting at index ${i}:`, error);
      failedCount += batch.length;
    }

    onProgress?.(Math.min(i + batchSize, chunks.length), chunks.length);
  }

  return {
    totalChunks: chunks.length,
    embeddedChunks: embeddedCount,
    failedChunks: failedCount,
    timeMs: Date.now() - startTime,
  };
}

function prepareChunkForEmbedding(chunk: ContentChunk): string {
  // Use Anthropic contextual retrieval prefix if available — it situates the
  // chunk within its page/section so the embedding captures meaning in context.
  if (chunk.contextPrefix) {
    return chunk.contextPrefix + "\n\n" + chunk.content;
  }

  // Fallback for chunks without contextPrefix (e.g. legacy data)
  const parts: string[] = [];

  // Add heading hierarchy as prefix for better retrieval
  if (chunk.metadata.headingHierarchy.length > 0) {
    parts.push(`[${chunk.metadata.headingHierarchy.join(" > ")}]`);
  }

  // Add page title for context
  if (chunk.metadata.title) {
    parts.push(`Page: ${chunk.metadata.title}`);
  }

  // Add the actual content
  parts.push(chunk.content);

  return parts.join("\n");
}

export async function searchContext(
  query: string,
  provider: EmbeddingProvider,
  store: VectorStore,
  options: { topK?: number; filter?: Record<string, unknown> } = {}
): Promise<{ content: string; metadata: Record<string, unknown>; score: number }[]> {
  const { topK = 5, filter } = options;

  const [queryEmbedding] = await provider.embed([query]);
  const results = await store.search(queryEmbedding, topK, filter);

  return results.map((r) => ({
    content: r.content,
    metadata: r.metadata,
    score: r.score,
  }));
}
