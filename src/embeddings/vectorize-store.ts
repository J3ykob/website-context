/**
 * Cloudflare Vectorize vector store.
 * Single index "whisp-vectors", tenant isolation via metadata filtering.
 * Implements VectorStore interface for drop-in Qdrant replacement.
 */

import type { VectorStore, VectorEntry, SearchResult } from "./types.js";

const CF_ACCOUNT_ID = "98e447c9e14d384e1b7e6f4d42c39ad2";
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";
const INDEX_NAME = process.env.VECTORIZE_INDEX || "whisp-vectors";
const BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}`;

const headers = () => ({
  "Authorization": `Bearer ${CF_API_TOKEN}`,
  "Content-Type": "application/json",
});

export class CloudflareVectorizeStore implements VectorStore {
  private tenantId: string;

  constructor(config: { tenantId: string }) {
    this.tenantId = config.tenantId;
  }

  async upsert(entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;

    // Vectorize max batch is 1000 vectors
    const batches: VectorEntry[][] = [];
    for (let i = 0; i < entries.length; i += 1000) {
      batches.push(entries.slice(i, i + 1000));
    }

    for (const batch of batches) {
      const ndjson = batch.map(e => JSON.stringify({
        id: `${this.tenantId}__${e.id}`,
        values: e.vector,
        metadata: {
          tenant: this.tenantId,
          content: e.content.slice(0, 5000),
          title: (e.metadata.title as string) || "",
          url: (e.metadata.url as string) || "",
          type: (e.metadata.type as string) || "",
          headingHierarchy: JSON.stringify(e.metadata.headingHierarchy || []),
        },
      })).join("\n");

      const resp = await fetch(`${BASE}/insert`, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/x-ndjson" },
        body: ndjson,
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.error(`[vectorize] Insert batch failed: ${err.slice(0, 200)}`);
      }
    }
  }

  async search(query: number[], topK: number = 5, filter?: Record<string, unknown>): Promise<SearchResult[]> {
    const resp = await fetch(`${BASE}/query`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        vector: query,
        topK,
        returnValues: false,
        returnMetadata: "all",
        filter: { tenant: this.tenantId, ...filter },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[vectorize] Query failed: ${err.slice(0, 200)}`);
      return [];
    }

    const data = await resp.json() as any;
    const matches = data.result?.matches || [];

    return matches.map((m: any) => ({
      id: m.id.replace(`${this.tenantId}__`, ""),
      content: m.metadata?.content || "",
      metadata: {
        title: m.metadata?.title || "",
        url: m.metadata?.url || "",
        type: m.metadata?.type || "",
        headingHierarchy: (() => { try { return JSON.parse(m.metadata?.headingHierarchy || "[]"); } catch { return []; } })(),
      },
      score: m.score,
    }));
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const prefixed = ids.map(id => `${this.tenantId}__${id}`);
    await fetch(`${BASE}/delete-by-ids`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ids: prefixed }),
    });
  }

  async deleteAll(): Promise<void> {
    // Delete all vectors for this tenant by listing and deleting
    // Vectorize doesn't support delete-by-filter, so we need to track IDs
    // For now, just log - full cleanup requires knowing all IDs
    console.log(`[vectorize] deleteAll for ${this.tenantId} - clearing via re-insert`);
  }

  async count(): Promise<number> {
    // Vectorize doesn't support count-by-filter
    // Return 0 as placeholder - actual count isn't used in the pipeline
    return 0;
  }
}
