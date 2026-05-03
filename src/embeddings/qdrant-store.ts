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

    this.initialized = true;
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
