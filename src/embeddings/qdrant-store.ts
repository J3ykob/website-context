import { createHash, randomUUID } from "crypto";
import type { VectorStore, VectorEntry, SearchResult } from "./types.js";

export interface QdrantConfig {
  host?: string;
  port?: number;
  collection: string;
  createIfMissing?: boolean;
}

export class QdrantVectorStore implements VectorStore {
  private baseUrl: string;
  private collection: string;
  private createIfMissing: boolean;
  private initialized = false;

  constructor(config: QdrantConfig) {
    const host = config.host || process.env.QDRANT_HOST || "152.53.243.28";
    const port = config.port || parseInt(process.env.QDRANT_PORT || "6333");
    this.baseUrl = `http://${host}:${port}`;
    this.collection = config.collection;
    this.createIfMissing = config.createIfMissing ?? true;
  }

  private async ensureCollection(vectorSize: number): Promise<void> {
    if (this.initialized) return;

    const checkResponse = await fetch(
      `${this.baseUrl}/collections/${this.collection}`
    );

    if (checkResponse.status === 404 && this.createIfMissing) {
      const createResponse = await fetch(
        `${this.baseUrl}/collections/${this.collection}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vectors: {
              size: vectorSize,
              distance: "Cosine",
            },
          }),
        }
      );

      if (!createResponse.ok) {
        throw new Error(
          `Failed to create Qdrant collection: ${await createResponse.text()}`
        );
      }
    }

    await this.createTextIndex();
    this.initialized = true;
  }

  /**
   * Creates a full-text index on the `content` payload field for BM25-style
   * keyword search. Idempotent — Qdrant ignores the call if the index exists.
   */
  private async createTextIndex(): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/collections/${this.collection}/index`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field_name: "content",
          field_schema: {
            type: "text",
            tokenizer: "word",
            min_token_len: 2,
            max_token_len: 30,
            lowercase: true,
          },
        }),
      }
    );

    // 400 can mean "index already exists" — that's fine
    if (!response.ok && response.status !== 400) {
      console.warn(
        `Warning: could not create text index on "content": ${await response.text()}`
      );
    }
  }

  async upsert(entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;

    await this.ensureCollection(entries[0].vector.length);

    const points = entries.map((entry) => ({
      id: toQdrantId(entry.id),
      vector: entry.vector,
      payload: {
        _original_id: entry.id,
        content: entry.content,
        ...entry.metadata,
      },
    }));

    // Qdrant has a max batch size, send in chunks of 100
    for (let i = 0; i < points.length; i += 100) {
      const batch = points.slice(i, i + 100);

      const response = await fetch(
        `${this.baseUrl}/collections/${this.collection}/points`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ points: batch }),
        }
      );

      if (!response.ok) {
        throw new Error(`Qdrant upsert failed: ${await response.text()}`);
      }
    }
  }

  async search(
    query: number[],
    topK: number = 5,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]> {
    await this.ensureCollection(query.length);

    const body: Record<string, unknown> = {
      vector: query,
      limit: topK,
      with_payload: true,
    };

    if (filter && Object.keys(filter).length > 0) {
      body.filter = {
        must: Object.entries(filter).map(([key, value]) => ({
          key,
          match: { value },
        })),
      };
    }

    const response = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      throw new Error(`Qdrant search failed: ${await response.text()}`);
    }

    const data = await response.json() as {
      result: { id: string; score: number; payload: Record<string, unknown> }[];
    };

    return data.result.map((point) => ({
      id: (point.payload._original_id as string) || String(point.id),
      content: (point.payload.content as string) || "",
      metadata: point.payload,
      score: point.score,
    }));
  }

  /**
   * Hybrid search combining dense vector similarity with full-text keyword
   * matching using Reciprocal Rank Fusion (RRF).
   *
   * Follows Anthropic's contextual retrieval recommendation of combining
   * dense embeddings with BM25-style keyword search.
   */
  async hybridSearch(
    query: number[],
    queryText: string,
    topK: number = 5,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]> {
    await this.ensureCollection(query.length);

    // Number of candidates to fetch from each source before RRF fusion
    const prefetchLimit = Math.max(topK * 5, 25);

    // Build optional Qdrant filter clause
    const qdrantFilter =
      filter && Object.keys(filter).length > 0
        ? {
            must: Object.entries(filter).map(([key, value]) => ({
              key,
              match: { value },
            })),
          }
        : undefined;

    // --- 1. Dense vector search ---
    const denseBody: Record<string, unknown> = {
      vector: query,
      limit: prefetchLimit,
      with_payload: true,
    };
    if (qdrantFilter) denseBody.filter = qdrantFilter;

    const densePromise = fetch(
      `${this.baseUrl}/collections/${this.collection}/points/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(denseBody),
      }
    );

    // --- 2. Full-text keyword search ---
    // Tokenize query into individual words matching the index settings
    const keywords = queryText
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2 && w.length <= 30);

    const textFilter: Record<string, unknown> = {
      must: [
        ...(qdrantFilter?.must ?? []),
        // Match any keyword (OR semantics) for broad recall
        {
          should: keywords.map((word) => ({
            key: "content",
            match: { text: word },
          })),
        },
      ],
    };

    const scrollBody: Record<string, unknown> = {
      filter: textFilter,
      limit: prefetchLimit,
      with_payload: true,
    };

    const textPromise = fetch(
      `${this.baseUrl}/collections/${this.collection}/points/scroll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scrollBody),
      }
    );

    // Run both searches in parallel
    const [denseResponse, textResponse] = await Promise.all([
      densePromise,
      textPromise,
    ]);

    // --- Parse dense results ---
    type QdrantPoint = {
      id: string;
      score?: number;
      payload: Record<string, unknown>;
    };

    let denseResults: QdrantPoint[] = [];
    if (denseResponse.ok) {
      const denseData = (await denseResponse.json()) as {
        result: QdrantPoint[];
      };
      denseResults = denseData.result;
    }

    // --- Parse text/scroll results ---
    let textResults: QdrantPoint[] = [];
    if (textResponse.ok) {
      const textData = (await textResponse.json()) as {
        result: { points: QdrantPoint[] };
      };
      textResults = textData.result.points ?? [];
    }

    // --- 3. Reciprocal Rank Fusion ---
    const RRF_K = 60;
    const SEMANTIC_WEIGHT = 0.7;
    const KEYWORD_WEIGHT = 0.3;

    const fusedScores = new Map<
      string,
      { point: QdrantPoint; score: number }
    >();

    // Score dense results by rank
    for (let rank = 0; rank < denseResults.length; rank++) {
      const point = denseResults[rank];
      const pointId = String(point.id);
      const rrfScore = SEMANTIC_WEIGHT * (1 / (RRF_K + rank + 1));
      const existing = fusedScores.get(pointId);
      if (existing) {
        existing.score += rrfScore;
      } else {
        fusedScores.set(pointId, { point, score: rrfScore });
      }
    }

    // Score text results by rank
    for (let rank = 0; rank < textResults.length; rank++) {
      const point = textResults[rank];
      const pointId = String(point.id);
      const rrfScore = KEYWORD_WEIGHT * (1 / (RRF_K + rank + 1));
      const existing = fusedScores.get(pointId);
      if (existing) {
        existing.score += rrfScore;
      } else {
        fusedScores.set(pointId, { point, score: rrfScore });
      }
    }

    // Sort by fused score descending, take topK
    const ranked = [...fusedScores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return ranked.map(({ point, score }) => ({
      id:
        (point.payload._original_id as string) || String(point.id),
      content: (point.payload.content as string) || "",
      metadata: point.payload,
      score,
    }));
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const response = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/delete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: ids.map(toQdrantId) }),
      }
    );

    if (!response.ok) {
      throw new Error(`Qdrant delete failed: ${await response.text()}`);
    }
  }

  async count(): Promise<number> {
    const response = await fetch(
      `${this.baseUrl}/collections/${this.collection}`
    );

    if (!response.ok) return 0;

    const data = await response.json() as {
      result: { points_count: number };
    };

    return data.result.points_count;
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toQdrantId(id: string): string {
  if (UUID_REGEX.test(id)) return id;
  // Generate a deterministic UUID v5-style from the string
  const hash = createHash("sha256").update(id).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "5" + hash.slice(13, 16), // version 5
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20), // variant
    hash.slice(20, 32),
  ].join("-");
}
