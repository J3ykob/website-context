import { readFile, readdir } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import type { FlowDefinition } from "../context/types.js";
import { downloadFromR2, uploadToR2 } from "../storage/r2.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, "../../data");

// Flows are PERSISTED IN R2 (the source of truth), not on the local disk — local
// disk on Render is ephemeral and was wiping recorded flows on every redeploy.
// One R2 object holds a tenant's whole flow list: tenants/<id>/flows.json. This
// scales to many tenants (per-tenant key, no list/scan) and the hot chat path
// never reads R2 — flows live in the cached tenant context (see tenant-manager,
// which loads them via getFlows at cold-load and the dashboard reloads them on
// edit). A short in-memory cache keeps dashboard polling / cold loads off R2.
const r2Key = (tenantId: string) => `tenants/${tenantId}/flows.json`;

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { flows: FlowDefinition[]; ts: number }>();
// Evict long-idle entries so the cache can't grow unbounded across many tenants.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.ts > CACHE_TTL_MS * 10) cache.delete(k);
}, 600_000);
(sweep as any).unref?.();

async function readR2(tenantId: string): Promise<FlowDefinition[] | null> {
  const buf = await downloadFromR2(r2Key(tenantId));
  if (!buf) return null;
  try {
    const arr = JSON.parse(buf.toString());
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeR2(tenantId: string, flows: FlowDefinition[]): Promise<void> {
  await uploadToR2(r2Key(tenantId), JSON.stringify(flows, null, 2), "application/json");
  cache.set(tenantId, { flows, ts: Date.now() });
}

// One-time migration when a tenant has no flows.json in R2 yet: recover any flows
// that still exist on the legacy local disk (data/<id>/flows/*.json) or in
// context-meta, then write them to R2 (even an empty list) so we never re-scan.
async function migrateLegacy(tenantId: string): Promise<FlowDefinition[]> {
  const byId = new Map<string, FlowDefinition>();
  const dir = join(DATA_ROOT, tenantId, "flows");
  if (existsSync(dir)) {
    try {
      for (const file of await readdir(dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const f = JSON.parse(await readFile(join(dir, file), "utf-8")) as FlowDefinition;
          if (f && f.id) byId.set(f.id, f);
        } catch { /* skip corrupt */ }
      }
    } catch { /* dir vanished */ }
  }
  const metaPath = join(DATA_ROOT, tenantId, "context-meta.json");
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf-8"));
      for (const f of (meta.flows || []) as FlowDefinition[]) if (f && f.id && !byId.has(f.id)) byId.set(f.id, f);
    } catch { /* ignore */ }
  }
  const flows = Array.from(byId.values());
  await writeR2(tenantId, flows); // mark migrated (writes [] if nothing found)
  return flows;
}

export async function getFlows(tenantId: string, opts?: { fresh?: boolean }): Promise<FlowDefinition[]> {
  if (!opts?.fresh) {
    const c = cache.get(tenantId);
    if (c && Date.now() - c.ts < CACHE_TTL_MS) return c.flows;
  }
  let flows = await readR2(tenantId);
  if (flows === null) flows = await migrateLegacy(tenantId);
  cache.set(tenantId, { flows, ts: Date.now() });
  return flows;
}

export async function getFlow(tenantId: string, flowId: string): Promise<FlowDefinition | null> {
  return (await getFlows(tenantId)).find((f) => f.id === flowId) || null;
}

export async function saveFlow(tenantId: string, flow: FlowDefinition): Promise<FlowDefinition> {
  const flows = await getFlows(tenantId, { fresh: true });
  const i = flows.findIndex((f) => f.id === flow.id);
  if (i >= 0) flows[i] = flow;
  else flows.push(flow);
  await writeR2(tenantId, flows);
  return flow;
}

export async function deleteFlow(tenantId: string, flowId: string): Promise<boolean> {
  const flows = await getFlows(tenantId, { fresh: true });
  const next = flows.filter((f) => f.id !== flowId);
  if (next.length === flows.length) return false;
  await writeR2(tenantId, next);
  return true;
}

export async function updateFlow(
  tenantId: string,
  flowId: string,
  updates: Partial<Pick<FlowDefinition, "name" | "description" | "triggerPhrases" | "status">>
): Promise<FlowDefinition | null> {
  const flows = await getFlows(tenantId, { fresh: true });
  const i = flows.findIndex((f) => f.id === flowId);
  if (i < 0) return null;
  flows[i] = { ...flows[i], ...updates, updatedAt: new Date().toISOString() };
  await writeR2(tenantId, flows);
  return flows[i];
}
