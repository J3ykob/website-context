/**
 * Tenant Registry backed by Cloudflare D1 (durable source of truth) with a small
 * in-memory cache for SYNCHRONOUS reads. Replaces the local-SQLite registry so the
 * Render instance holds no durable state and can be restarted/scaled freely.
 *
 * Design:
 *  - D1 is authoritative. The cache (Map of ~hundreds of small records, a few MB)
 *    is hydrated from D1 at boot and refreshed periodically, so getTenant/listTenants
 *    stay synchronous (no per-call D1 round-trip on the hot chat path, no async ripple).
 *  - Writes update the cache synchronously, then persist to D1 (write-through, retried).
 *  - The D1 query function is injectable (__setQuery) so the cache logic is unit-testable
 *    deterministically without network.
 */

import { normalizeTenantId } from "./tenant-id.js";

export interface TenantRecord {
  id: string;
  email: string;
  domain: string;
  siteUrl: string;
  brandName: string | null;
  status: "pending" | "scraping" | "active" | "error" | "broken";
  createdAt: string;
  updatedAt: string;
  lastScrapedAt: string | null;
  pagesCount: number;
  chunksCount: number;
  qdrantCollection: string;
  settings: any;
  ownerPasswordHash: string | null;
  apiKey: string | null;
  setupToken: string | null;
}

interface TenantRow {
  id: string; email: string; domain: string; site_url: string; brand_name: string | null;
  status: string; created_at: string; updated_at: string; last_scraped_at: string | null;
  pages_count: number; chunks_count: number; qdrant_collection: string; settings_json: string;
  owner_password_hash: string | null; api_key: string | null; setup_token: string | null;
}

const CF_ACCOUNT_ID = "98e447c9e14d384e1b7e6f4d42c39ad2";
const D1_DATABASE_ID = process.env.D1_DATABASE_ID || "0dec9229-fea2-4343-bf87-d36ac3205979";
const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;

type QueryFn = (sql: string, params?: any[]) => Promise<any[]>;

const realQuery: QueryFn = async (sql, params = []) => {
  const { getCfToken } = await import("../storage/cf-auth.js"); // lazy: avoid R2 boot-throw in tests
  const resp = await fetch(D1_BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${getCfToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  if (!resp.ok) throw new Error(`D1 query failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as any;
  return data.result?.[0]?.results || [];
};

let query: QueryFn = realQuery;
/** Test seam: inject a fake D1 query (and reset the cache). */
export function __setQuery(fn: QueryFn | null): void {
  query = fn || realQuery;
  byId.clear();
  byDomain.clear();
}

function rowToRecord(row: TenantRow): TenantRecord {
  return {
    id: row.id, email: row.email, domain: row.domain, siteUrl: row.site_url,
    brandName: row.brand_name, status: row.status as TenantRecord["status"],
    createdAt: row.created_at, updatedAt: row.updated_at, lastScrapedAt: row.last_scraped_at,
    pagesCount: row.pages_count, chunksCount: row.chunks_count, qdrantCollection: row.qdrant_collection,
    settings: JSON.parse(row.settings_json || "{}"),
    ownerPasswordHash: row.owner_password_hash, apiKey: row.api_key, setupToken: row.setup_token,
  };
}

const UPSERT_COLS = "id,email,domain,site_url,brand_name,status,created_at,updated_at,last_scraped_at,pages_count,chunks_count,qdrant_collection,settings_json,owner_password_hash,api_key,setup_token";
function recordParams(r: TenantRecord): any[] {
  return [r.id, r.email, r.domain, r.siteUrl, r.brandName, r.status, r.createdAt, r.updatedAt,
    r.lastScrapedAt, r.pagesCount, r.chunksCount, r.qdrantCollection, JSON.stringify(r.settings || {}),
    r.ownerPasswordHash, r.apiKey, r.setupToken];
}

// ─── In-memory cache (hydrated from D1) ──────────────────────────────────────
const byId = new Map<string, TenantRecord>();
const byDomain = new Map<string, string>();

export async function hydrateRegistry(): Promise<number> {
  const rows = (await query("SELECT * FROM tenants")) as TenantRow[];
  byId.clear();
  byDomain.clear();
  for (const row of rows) {
    const rec = rowToRecord(row);
    byId.set(rec.id, rec);
    byDomain.set(rec.domain, rec.id);
  }
  return byId.size;
}

// Periodic refresh — picks up external/other-instance changes (eventual consistency).
const refresh = setInterval(() => {
  hydrateRegistry().catch((e) => console.error(`[d1-registry] refresh failed: ${(e as Error).message}`));
}, 60_000);
(refresh as any).unref?.();

// Write-through to D1: cache is already updated synchronously by the caller, so a
// transient D1 failure never breaks the request — retry once, then log loudly.
function persist(sql: string, params: any[], label: string): void {
  query(sql, params).catch((e) => {
    console.error(`[d1-registry] ${label} write failed, retrying: ${(e as Error).message}`);
    query(sql, params).catch((e2) => console.error(`[d1-registry] ${label} write FAILED after retry: ${(e2 as Error).message}`));
  });
}
function upsert(rec: TenantRecord, label: string): void {
  persist(`INSERT OR REPLACE INTO tenants (${UPSERT_COLS}) VALUES (${UPSERT_COLS.split(",").map(() => "?").join(",")})`, recordParams(rec), label);
}

// ─── Synchronous reads (from cache) ──────────────────────────────────────────
export function getTenant(id: string): TenantRecord | null {
  return byId.get(id) || null;
}
export function getTenantByDomain(domain: string): TenantRecord | null {
  const id = byDomain.get(domain);
  return id ? byId.get(id) || null : null;
}
export function listTenants(): TenantRecord[] {
  return Array.from(byId.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// ─── Writes (cache-sync + write-through to D1) ───────────────────────────────
function newRecord(id: string, email: string, domain: string, siteUrl: string, status: TenantRecord["status"]): TenantRecord {
  const now = new Date().toISOString();
  return {
    id, email, domain, siteUrl, brandName: null, status, createdAt: now, updatedAt: now,
    lastScrapedAt: null, pagesCount: 0, chunksCount: 0, qdrantCollection: `wctx_${id}`,
    settings: {}, ownerPasswordHash: null, apiKey: null, setupToken: null,
  };
}

export function createTenant(email: string, siteUrl: string): TenantRecord {
  const domain = new URL(siteUrl).hostname;
  const id = normalizeTenantId(domain);
  if (byId.has(id)) throw new Error(`Tenant already exists: ${id}`);
  const rec = newRecord(id, email, domain, siteUrl, "pending");
  byId.set(id, rec);
  byDomain.set(domain, id);
  upsert(rec, "createTenant");
  return rec;
}

// Create a tenant for a business with NO website (interview-based onboarding).
// Id comes from the business name (not a domain); a synthetic .whisp.site domain
// keeps the byDomain index unique. No scrape is queued — the KB is built by the
// interview. Starts "pending"; caller flips to "active" once chunks are stored.
export function createManualTenant(email: string, businessName: string): TenantRecord {
  const base = businessName.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "biz";
  let id = base, n = 1;
  while (byId.has(id)) id = `${base}_${n++}`;
  const domain = `${id.replace(/_/g, "-")}.whisp.site`;
  const rec = newRecord(id, email, domain, "", "pending");
  rec.brandName = businessName.trim().slice(0, 120);
  byId.set(id, rec);
  byDomain.set(domain, id);
  upsert(rec, "createManualTenant");
  return rec;
}

export function ensureTenant(id: string, email: string, domain: string, siteUrl: string): TenantRecord | null {
  const existing = byId.get(id);
  if (existing) return existing;
  const rec = newRecord(id, email, domain, siteUrl, "active");
  byId.set(id, rec);
  byDomain.set(domain, id);
  upsert(rec, "ensureTenant");
  return rec;
}

const UPDATE_COL_MAP: Record<string, string> = {
  email: "email", siteUrl: "site_url", brandName: "brand_name", status: "status",
  lastScrapedAt: "last_scraped_at", pagesCount: "pages_count", chunksCount: "chunks_count",
  settings: "settings_json", ownerPasswordHash: "owner_password_hash", apiKey: "api_key",
  setupToken: "setup_token",
};

export function updateTenant(id: string, updates: Partial<{
  email: string; siteUrl: string; brandName: string | null; status: TenantRecord["status"];
  lastScrapedAt: string | null; pagesCount: number; chunksCount: number;
  settings: any; ownerPasswordHash: string | null; apiKey: string | null; setupToken: string | null;
}>): void {
  const rec = byId.get(id);
  if (!rec) return;
  Object.assign(rec, updates);
  rec.updatedAt = new Date().toISOString();
  // Persist ONLY the changed columns. The old full-record INSERT OR REPLACE let two
  // near-simultaneous updates race over D1: whichever HTTP request landed LAST won
  // the entire row. createTenant + the setupToken update fire ~1ms apart; when the
  // create landed second, D1 kept setup_token=NULL, the 60s hydrate then poisoned
  // the cache, and every password-setup email link was dead (2026-07-19). Partial
  // UPDATEs of disjoint fields commute, so ordering no longer matters.
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(updates)) {
    const col = UPDATE_COL_MAP[k];
    if (!col || v === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(k === "settings" ? JSON.stringify(v || {}) : v);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  params.push(rec.updatedAt, id);
  persist(`UPDATE tenants SET ${sets.join(", ")} WHERE id = ?`, params, "updateTenant");
}

export function deleteTenant(id: string): void {
  const rec = byId.get(id);
  if (rec) byDomain.delete(rec.domain);
  byId.delete(id);
  persist("DELETE FROM tenants WHERE id = ?", [id], "deleteTenant");
  persist("DELETE FROM sessions WHERE tenant_id = ?", [id], "deleteTenant.sessions");
}
