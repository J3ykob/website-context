/**
 * Tenant Registry — CRUD operations for tenant records in SQLite.
 */

import { getDb } from "./db/connection.js";
import { runMigrations } from "./db/migrations.js";
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
  id: string;
  email: string;
  domain: string;
  site_url: string;
  brand_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_scraped_at: string | null;
  pages_count: number;
  chunks_count: number;
  qdrant_collection: string;
  settings_json: string;
  owner_password_hash: string | null;
  api_key: string | null;
  setup_token: string | null;
}

function rowToRecord(row: TenantRow): TenantRecord {
  return {
    id: row.id,
    email: row.email,
    domain: row.domain,
    siteUrl: row.site_url,
    brandName: row.brand_name,
    status: row.status as TenantRecord["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastScrapedAt: row.last_scraped_at,
    pagesCount: row.pages_count,
    chunksCount: row.chunks_count,
    qdrantCollection: row.qdrant_collection,
    settings: JSON.parse(row.settings_json || "{}"),
    ownerPasswordHash: row.owner_password_hash,
    apiKey: row.api_key,
    setupToken: row.setup_token,
  };
}

let migrated = false;
function ensureMigrated(): void {
  if (!migrated) {
    runMigrations();
    migrated = true;
  }
}

export function createTenant(email: string, siteUrl: string): TenantRecord {
  ensureMigrated();
  const db = getDb();

  const domain = new URL(siteUrl).hostname;
  // Canonical id MUST match the VPS scraper form (see tenant-id.ts) so the
  // registry row, Vectorize namespace, R2 path and demo URL all agree — the old
  // `domain.replace(/\./g,"_")` kept hyphens and broke hyphenated domains.
  const id = normalizeTenantId(domain);
  const qdrantCollection = `wctx_${id}`;

  const stmt = db.prepare(`
    INSERT INTO tenants (id, email, domain, site_url, qdrant_collection)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(id, email, domain, siteUrl, qdrantCollection);

  return getTenant(id)!;
}

// Idempotent register-or-fetch with an explicit id (used to self-heal a tenant
// from its R2 context-meta when it's missing from the registry — e.g. the VPS
// outreach scraped + emailed it but the Render registration call failed). Uses
// INSERT OR IGNORE so it never throws on an existing row, unlike createTenant.
export function ensureTenant(id: string, email: string, domain: string, siteUrl: string): TenantRecord | null {
  ensureMigrated();
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO tenants (id, email, domain, site_url, qdrant_collection, status)
     VALUES (?, ?, ?, ?, ?, 'active')`
  ).run(id, email, domain, siteUrl, `wctx_${id}`);
  return getTenant(id);
}

export function getTenant(id: string): TenantRecord | null {
  ensureMigrated();
  const db = getDb();

  const row = db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as TenantRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function getTenantByDomain(domain: string): TenantRecord | null {
  ensureMigrated();
  const db = getDb();

  const row = db.prepare("SELECT * FROM tenants WHERE domain = ?").get(domain) as TenantRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function updateTenant(id: string, updates: Partial<{
  email: string;
  brandName: string | null;
  status: TenantRecord["status"];
  lastScrapedAt: string | null;
  pagesCount: number;
  chunksCount: number;
  settings: any;
  ownerPasswordHash: string | null;
  apiKey: string | null;
  setupToken: string | null;
}>): void {
  ensureMigrated();
  const db = getDb();

  const setClauses: string[] = [];
  const values: any[] = [];

  if (updates.email !== undefined) {
    setClauses.push("email = ?");
    values.push(updates.email);
  }
  if (updates.brandName !== undefined) {
    setClauses.push("brand_name = ?");
    values.push(updates.brandName);
  }
  if (updates.status !== undefined) {
    setClauses.push("status = ?");
    values.push(updates.status);
  }
  if (updates.lastScrapedAt !== undefined) {
    setClauses.push("last_scraped_at = ?");
    values.push(updates.lastScrapedAt);
  }
  if (updates.pagesCount !== undefined) {
    setClauses.push("pages_count = ?");
    values.push(updates.pagesCount);
  }
  if (updates.chunksCount !== undefined) {
    setClauses.push("chunks_count = ?");
    values.push(updates.chunksCount);
  }
  if (updates.settings !== undefined) {
    setClauses.push("settings_json = ?");
    values.push(JSON.stringify(updates.settings));
  }
  if (updates.ownerPasswordHash !== undefined) {
    setClauses.push("owner_password_hash = ?");
    values.push(updates.ownerPasswordHash);
  }
  if (updates.apiKey !== undefined) {
    setClauses.push("api_key = ?");
    values.push(updates.apiKey);
  }
  if (updates.setupToken !== undefined) {
    setClauses.push("setup_token = ?");
    values.push(updates.setupToken);
  }

  if (setClauses.length === 0) return;

  setClauses.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE tenants SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function listTenants(): TenantRecord[] {
  ensureMigrated();
  const db = getDb();

  const rows = db.prepare("SELECT * FROM tenants ORDER BY created_at DESC").all() as TenantRow[];
  return rows.map(rowToRecord);
}

export function deleteTenant(id: string): void {
  ensureMigrated();
  const db = getDb();

  db.prepare("DELETE FROM tenants WHERE id = ?").run(id);
  db.prepare("DELETE FROM scrape_jobs WHERE tenant_id = ?").run(id);
  db.prepare("DELETE FROM sessions WHERE tenant_id = ?").run(id);
}
