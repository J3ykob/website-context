/**
 * Cloudflare Vectorize vector store.
 * Single index "whisp-vectors", tenant isolation via metadata filtering.
 * Implements VectorStore interface for drop-in Qdrant replacement.
 */

import type { VectorStore, VectorEntry, SearchResult } from "./types.js";
import { getCfToken } from "../storage/cf-auth.js";

const CF_ACCOUNT_ID = "98e447c9e14d384e1b7e6f4d42c39ad2";
const INDEX_NAME = process.env.VECTORIZE_INDEX || "whisp-vectors";
const BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}`;

const headers = () => ({
  "Authorization": `Bearer ${getCfToken()}`,
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
        // FAIL LOUD. Previously this only logged, so an expired CF token (401)
        // or any insert error produced "embedded N chunks" with ZERO vectors in
        // Vectorize -> demo marked active + emailed but chat ungrounded. Throwing
        // lets embedChunks count this as a failure so the scrape gate catches it.
        const err = await resp.text();
        throw new Error(`Vectorize insert failed (HTTP ${resp.status}): ${err.slice(0, 200)}`);
      }
    }
  }

  // True if this tenant has at least one queryable vector. Used as the
  // load-bearing readiness check — local "embedded N" counts lie (see upsert).
  async hasVectors(): Promise<boolean> {
    const probe = new Array(1024).fill(0.01);
    const hits = await this.search(probe, 1);
    return hits.length > 0;
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
      // FAIL LOUD on HTTP errors (e.g. 401 expired token, Vectorize down) so the
      // chat layer can return 503 instead of a silent ungrounded answer. A valid
      // query with zero matches still returns [] below (that's not an error).
      const err = await resp.text();
      throw new Error(`Vectorize query failed (HTTP ${resp.status}): ${err.slice(0, 200)}`);
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
    await fetch(`${BASE}/delete_by_ids`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ids: prefixed }),
    });
  }

  // Fully delete a tenant's vectors. Vectorize has no delete-by-filter or list
  // API, and deletes are ASYNC (delete_by_ids returns a mutationId; the vector
  // stays queryable for ~tens of seconds until processed). A FIXED query probe
  // just re-surfaces the same not-yet-processed batch and stalls, so each pass
  // uses a FRESH RANDOM probe (hitting a different region of the space) and
  // deletes every ID returned. We sweep in rounds: an inner loop issues deletes
  // until random probes stop surfacing anything new (coverage saturated), then
  // we wait for async processing and verify with random samples; we repeat until
  // a post-wait sample comes back empty. Invoked once per tenant (legacy drain).
  async deleteAll(): Promise<number> {
    const randProbe = (): number[] => {
      const v = new Array(1024);
      let n = 0;
      for (let i = 0; i < 1024; i++) { const x = Math.random() * 2 - 1; v[i] = x; n += x * x; }
      n = Math.sqrt(n) || 1;
      return v.map((x) => x / n);
    };
    const queryIds = async (vec: number[]): Promise<string[] | null> => {
      const resp = await fetch(`${BASE}/query`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ vector: vec, topK: 100, returnValues: false, returnMetadata: "none", filter: { tenant: this.tenantId } }),
      });
      if (!resp.ok) { console.error(`[vectorize] deleteAll query failed: ${(await resp.text()).slice(0, 150)}`); return null; }
      return (((await resp.json()) as any).result?.matches || []).map((m: any) => m.id);
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const seen = new Set<string>();
    for (let round = 1; round <= 25; round++) {
      let lowStreak = 0;
      for (let pass = 0; pass < 250; pass++) {
        const ids = await queryIds(randProbe());
        if (ids === null) { await sleep(2000); continue; }
        if (ids.length === 0) { lowStreak += 2; if (lowStreak >= 10) break; await sleep(1500); continue; }
        const fresh = ids.filter((id) => !seen.has(id)).length;
        await fetch(`${BASE}/delete_by_ids`, { method: "POST", headers: headers(), body: JSON.stringify({ ids }) });
        ids.forEach((id) => seen.add(id));
        if (fresh <= 2) lowStreak++; else lowStreak = 0;
        if (lowStreak >= 10) break;
        await sleep(700);
      }
      // Let async deletes process, then verify with random samples.
      await sleep(15000);
      let still = 0;
      for (let v = 0; v < 8; v++) { const ids = await queryIds(randProbe()); still += (ids || []).length; await sleep(300); }
      if (still === 0) break;
    }
    console.log(`[vectorize] deleteAll ${this.tenantId}: ${seen.size} unique vectors removed`);
    return seen.size;
  }

  async count(): Promise<number> {
    // Vectorize doesn't support count-by-filter
    // Return 0 as placeholder - actual count isn't used in the pipeline
    return 0;
  }
}
