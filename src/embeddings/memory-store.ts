import type { VectorStore, VectorEntry, SearchResult } from "./types.js";

export class InMemoryVectorStore implements VectorStore {
  private entries: Map<string, VectorEntry> = new Map();

  async upsert(entries: VectorEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
  }

  async search(
    query: number[],
    topK: number = 5,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    for (const entry of this.entries.values()) {
      // Apply metadata filter if provided
      if (filter && !matchesFilter(entry.metadata, filter)) {
        continue;
      }

      const score = cosineSimilarity(query, entry.vector);
      results.push({
        id: entry.id,
        content: entry.content,
        metadata: entry.metadata,
        score,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.entries.delete(id);
    }
  }

  async count(): Promise<number> {
    return this.entries.size;
  }

  getAll(): VectorEntry[] {
    return Array.from(this.entries.values());
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

function matchesFilter(metadata: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (metadata[key] !== value) return false;
  }
  return true;
}
