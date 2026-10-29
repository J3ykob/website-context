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

  const MAX_RETRIES = 3;

  // One batch: retried with backoff; if it still fails, split in halves so one bad chunk (or a batch the
  // embedding service rejects, "8008: Internal server error") doesn't lose the other 49 (empro.pro,
  // 2026-10-29: 3 batches of 50 lost in a row).
  const runBatch = async (batch: ContentChunk[], label: string): Promise<void> => {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const embeddings = await provider.embed(batch.map((chunk) => prepareChunkForEmbedding(chunk)));
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
        return;
      } catch (error) {
        if (attempt < MAX_RETRIES) {
          const delay = attempt * 2000;
          console.warn(`Embed batch ${label} failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        } else if (batch.length > 1) {
          console.warn(`Embed batch ${label} failed ${MAX_RETRIES} times - splitting it`);
          const half = Math.ceil(batch.length / 2);
          await runBatch(batch.slice(0, half), `${label}a`);
          await runBatch(batch.slice(half), `${label}b`);
        } else {
          console.error(`Failed to embed chunk ${label} (${batch[0].metadata.url}) after ${MAX_RETRIES} attempts:`, error);
          failedCount += 1;
        }
      }
    }
  };

  // A few batches at a time (EMBED_CONCURRENCY, default 4): one at a time took ~20 min for a 3k-chunk shop.
  const starts: number[] = [];
  for (let i = 0; i < chunks.length; i += batchSize) starts.push(i);
  let next = 0, done = 0;
  const lane = async () => {
    while (next < starts.length) {
      const i = starts[next++];
      await runBatch(chunks.slice(i, i + batchSize), String(i));
      done += Math.min(batchSize, chunks.length - i);
      onProgress?.(done, chunks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(process.env.EMBED_CONCURRENCY) || 4) }, lane));

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

  // Use hybrid search (dense + keyword via RRF) when the store supports it,
  // falling back to pure dense vector search otherwise.
  const results = store.hybridSearch
    ? await store.hybridSearch(queryEmbedding, query, topK, filter)
    : await store.search(queryEmbedding, topK, filter);

  return results.map((r) => ({
    content: r.content,
    metadata: { ...r.metadata, id: r.id },
    score: r.score,
  }));
}
