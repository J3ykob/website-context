/**
 * Migrate tenant vectors from Qdrant to Cloudflare Vectorize.
 * Reads from Qdrant collections, writes to Vectorize with tenant metadata.
 *
 * Usage: CF_API_TOKEN=xxx npx tsx scripts/migrate-to-vectorize.ts [--limit=10]
 */

import { CloudflareVectorizeStore } from "../src/embeddings/vectorize-store.js";

const QDRANT_HOST = process.env.QDRANT_HOST || "152.53.243.28";
const QDRANT_PORT = process.env.QDRANT_PORT || "6333";
const LIMIT = parseInt(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] || "999");

async function listQdrantCollections(): Promise<string[]> {
  const resp = await fetch(`http://${QDRANT_HOST}:${QDRANT_PORT}/collections`);
  const data = await resp.json() as any;
  return (data.result?.collections || []).map((c: any) => c.name).filter((n: string) => n.startsWith("wctx_"));
}

async function getQdrantVectors(collection: string): Promise<any[]> {
  const resp = await fetch(`http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${collection}/points/scroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 500, with_payload: true, with_vector: true }),
  });
  const data = await resp.json() as any;
  return data.result?.points || [];
}

async function main() {
  const collections = await listQdrantCollections();
  console.log(`Found ${collections.length} Qdrant collections`);

  let migrated = 0;
  let failed = 0;

  for (const collection of collections.slice(0, LIMIT)) {
    const tenantId = collection.replace("wctx_", "");
    console.log(`\n[${migrated + 1}/${Math.min(collections.length, LIMIT)}] ${tenantId}...`);

    try {
      const points = await getQdrantVectors(collection);
      if (points.length === 0) { console.log("  Skip - 0 vectors"); continue; }

      const store = new CloudflareVectorizeStore({ tenantId });
      const entries = points.map((p: any) => ({
        id: p.id?.toString() || `${tenantId}_${Math.random().toString(36).slice(2)}`,
        vector: p.vector,
        content: p.payload?.content || "",
        metadata: {
          title: p.payload?.title || "",
          url: p.payload?.url || "",
          type: p.payload?.type || "",
          headingHierarchy: p.payload?.headingHierarchy || [],
        },
      }));

      await store.upsert(entries);
      migrated++;
      console.log(`  Migrated ${entries.length} vectors`);
    } catch (err: any) {
      failed++;
      console.log(`  FAILED: ${err.message}`);
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDONE: ${migrated} migrated, ${failed} failed`);
}

main().catch(console.error);
