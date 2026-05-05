export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
  modelName: string;
}

export interface EmbeddingConfig {
  provider: "openai" | "local";
  model?: string;
  apiKey?: string;
  batchSize?: number;
  baseUrl?: string;
}

export interface VectorEntry {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
  content: string;
}

export interface SearchResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

export interface VectorStore {
  upsert(entries: VectorEntry[]): Promise<void>;
  search(query: number[], topK?: number, filter?: Record<string, unknown>): Promise<SearchResult[]>;
  hybridSearch?(
    query: number[],
    queryText: string,
    topK?: number,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]>;
  delete(ids: string[]): Promise<void>;
  count(): Promise<number>;
}
