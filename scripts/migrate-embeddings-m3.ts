/**
 * Re-embed every tenant into the multilingual bge-m3 space.
 *
 * Reads each tenant's vectors (content + metadata) from the OLD index
 * (whisp-vectors, bge-large-en), embeds the same text with bge-m3 and upserts
 * them with the same ids into the NEW index (whisp-vectors-m3). Also re-embeds
 * the intent-engine anchors in D1 (question_intents.embedding), which would
 * otherwise be compared across two embedding spaces. The old index is never
 * modified, so rollback = keep EMBED_MODEL/VECTORIZE_INDEX on the old values.
 *
 * Ids come from R2 tenants/<id>/vector-ids.json plus random-probe discovery on
 * the old index (catches dashboard-added "manual_" chunks that the scrape list
 * does not track). Progress is checkpointed so the run can be resumed.
 *
 * Env: CF_API_TOKEN, R2_ACCESS_KEY, R2_SECRET_KEY, BGE_URL, BGE_API_KEY, ADMIN_SECRET.
 * Usage: npx tsx scripts/migrate-embeddings-m3.ts [--tenants a,b] [--checkpoint file]
 *
 * Not imported by the server (scripts/ is not type-checked in the build).
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { CloudflareVectorizeStore } from "../src/embeddings/vectorize-store.js";
import { BGEEmbeddingProvider } from "../src/embeddings/bge-provider.js";
import { downloadFromR2 } from "../src/storage/r2.js";

const OLD_INDEX = "whisp-vectors";
const NEW_INDEX = "whisp-vectors-m3";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "98e447c9e14d384e1b7e6f4d42c39ad2";
const D1_ID = process.env.D1_DATABASE_ID || "0dec9229-fea2-4343-bf87-d36ac3205979";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const checkpointFile = arg("--checkpoint") || "migrate-m3-checkpoint.json";
const done: Record<string, { vectors: number; anchors: number; at: string }> = existsSync(checkpointFile) ? JSON.parse(readFileSync(checkpointFile, "utf8")) : {};

const m3 = new BGEEmbeddingProvider({ model: "bge-m3", batchSize: 50 });

async function d1(sql: string, params: unknown[] = []): Promise<any[]> {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_ID}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const j = (await r.json()) as any;
  if (!j.success) throw new Error(`D1: ${JSON.stringify(j.errors).slice(0, 200)}`);
  return j.result?.[0]?.results || [];
}

async function tenantIds(): Promise<string[]> {
  const only = arg("--tenants");
  if (only) return only.split(",").map((s) => s.trim()).filter(Boolean);
  const r = await fetch(`https://whisp.so/api/admin/tenants?secret=${encodeURIComponent(process.env.ADMIN_SECRET || "")}`);
  if (!r.ok) throw new Error(`tenant list: HTTP ${r.status}`);
  const list = (await r.json()) as { id: string; chunksCount?: number }[];
  return list.map((t) => t.id);
}

function randomUnit(): number[] {
  const v = Array.from({ length: 1024 }, () => Math.random() * 2 - 1);
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((x) => x / n);
}

async function discoverIds(oldStore: CloudflareVectorizeStore, tenantId: string): Promise<string[]> {
  const ids = new Set<string>();
  const buf = await downloadFromR2(`tenants/${tenantId}/vector-ids.json`).catch(() => null);
  if (buf) { try { for (const id of JSON.parse(buf.toString())) ids.add(String(id)); } catch {} }
  // Random probes until 3 in a row find nothing new (bounded).
  let quiet = 0;
  for (let probe = 0; probe < 60 && quiet < 3; probe++) {
    const found = await oldStore.searchIds(randomUnit(), 100);
    const before = ids.size;
    // Probe ids come back with the tenant prefix ("<tenant>__<id>" or "t<md5>__<id>");
    // the R2 list holds bare ids. Normalise so each vector is counted and moved once.
    for (const id of found) ids.add(id.replace(/^.*?__/, ""));
    quiet = ids.size === before ? quiet + 1 : 0;
    if (found.length === 0) break;
  }
  return [...ids];
}

// --skip-anchors: vectors only (run BEFORE switching the server to bge-m3).
// --anchors-only: intent anchors only (run AFTER the switch, so the live intent
// engine never compares vectors from two embedding spaces).
const SKIP_ANCHORS = process.argv.includes("--skip-anchors");
const ANCHORS_ONLY = process.argv.includes("--anchors-only");

async function migrateTenant(tenantId: string): Promise<{ vectors: number; anchors: number }> {
  if (ANCHORS_ONLY) return { vectors: 0, anchors: await migrateAnchors(tenantId) };
  const oldStore = new CloudflareVectorizeStore({ tenantId, indexName: OLD_INDEX });
  const newStore = new CloudflareVectorizeStore({ tenantId, indexName: NEW_INDEX });
  const ids = await discoverIds(oldStore, tenantId);
  let vectors = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const items = (await oldStore.getByIds(ids.slice(i, i + 200))).filter((x) => x.content && x.content.trim());
    if (items.length === 0) continue;
    const embs = await m3.embed(items.map((x) => x.content));
    await newStore.upsert(items.map((x, k) => ({ id: x.id, vector: embs[k], content: x.content, metadata: x.metadata })));
    vectors += items.length;
  }
  return { vectors, anchors: SKIP_ANCHORS ? 0 : await migrateAnchors(tenantId) };
}

// Intent anchors live in D1 with their embedding: re-embed from the stored text.
async function migrateAnchors(tenantId: string): Promise<number> {
  let anchors = 0;
  const rows = await d1("SELECT id, canonical FROM question_intents WHERE tenant_id = ?", [tenantId]).catch(() => []);
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const embs = await m3.embed(batch.map((r: any) => String(r.canonical || "")));
    for (let k = 0; k < batch.length; k++) {
      await d1("UPDATE question_intents SET embedding = ? WHERE id = ?", [JSON.stringify(embs[k]), batch[k].id]);
      anchors++;
    }
  }
  return anchors;
}

async function main() {
  const all = await tenantIds();
  const todo = all.filter((t) => !done[t]);
  console.log(`[migrate-m3] ${all.length} tenants, ${todo.length} to go (checkpoint ${checkpointFile})`);
  let n = 0;
  const workers = Array.from({ length: Number(arg("--concurrency") || 4) }, async () => {
    while (todo.length) {
      const t = todo.shift()!;
      try {
        const r = await migrateTenant(t);
        done[t] = { ...r, at: new Date().toISOString() };
        writeFileSync(checkpointFile, JSON.stringify(done, null, 1));
        console.log(`[migrate-m3] ${++n}/${all.length} ${t}: ${r.vectors} vectors, ${r.anchors} anchors`);
      } catch (e: any) {
        console.error(`[migrate-m3] FAILED ${t}: ${e?.message || e}`);
      }
    }
  });
  await Promise.all(workers);
  console.log(`[migrate-m3] done: ${Object.keys(done).length}/${all.length} migrated`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
