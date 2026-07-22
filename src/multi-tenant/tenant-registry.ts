/**
 * Tenant Registry — now backed by Cloudflare D1 (durable, instance-independent).
 *
 * This module is a thin re-export of the D1-backed implementation in d1-registry.ts.
 * Reads are synchronous (served from an in-memory cache hydrated from D1 at boot +
 * 60s refresh); writes are write-through to D1. Kept as a stable import path so the
 * ~60 existing `tenant-registry.js` import sites are unchanged. The legacy local
 * SQLite registry (db/connection.ts) is no longer the source of truth — it remains
 * only for the worker's transient scrape_jobs and as the one-time migration source.
 */

export type { TenantRecord } from "./d1-registry.js";
export {
  getTenant,
  getTenantByDomain,
  listTenants,
  createTenant,
  createManualTenant,
  ensureTenant,
  updateTenant,
  deleteTenant,
  hydrateRegistry,
} from "./d1-registry.js";
