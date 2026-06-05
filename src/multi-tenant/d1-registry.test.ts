/**
 * D1 registry + auth tests. The injected "D1" is an in-memory better-sqlite3 DB —
 * D1 is SQLite, so this exercises the REAL SQL + cache/write-through logic
 * deterministically (no network, no mocks).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as registry from "./d1-registry.js";
import * as auth from "./d1-auth.js";

let mem: Database.Database;

// Injected D1 query: run the SQL against in-memory SQLite.
function makeQuery(db: Database.Database) {
  return async (sql: string, params: any[] = []): Promise<any[]> => {
    const stmt = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return stmt.all(...params) as any[];
    stmt.run(...params);
    return [];
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0)); // let write-through settle

beforeEach(async () => {
  mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, site_url TEXT NOT NULL,
      brand_name TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_scraped_at TEXT, pages_count INTEGER DEFAULT 0, chunks_count INTEGER DEFAULT 0,
      qdrant_collection TEXT NOT NULL, settings_json TEXT DEFAULT '{}',
      owner_password_hash TEXT, api_key TEXT, setup_token TEXT);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  const q = makeQuery(mem);
  registry.__setQuery(q); // also clears the cache
  auth.__setQuery(q);
  await registry.hydrateRegistry();
});
afterEach(() => {
  registry.__setQuery(null);
  auth.__setQuery(null);
  mem.close();
});

describe("d1-registry CRUD + cache", () => {
  it("createTenant: sync read + persisted to D1", async () => {
    const rec = registry.createTenant("a@x.com", "https://acme.co.uk");
    expect(rec.id).toBe("acme_co_uk");
    expect(registry.getTenant("acme_co_uk")?.email).toBe("a@x.com");
    expect(registry.getTenantByDomain("acme.co.uk")?.id).toBe("acme_co_uk");
    await flush();
    const row = mem.prepare("SELECT * FROM tenants WHERE id=?").get("acme_co_uk") as any;
    expect(row.domain).toBe("acme.co.uk");
    expect(row.status).toBe("pending");
  });

  it("createTenant: throws on duplicate", () => {
    registry.createTenant("a@x.com", "https://dup.com");
    expect(() => registry.createTenant("b@x.com", "https://dup.com")).toThrow();
  });

  it("ensureTenant: idempotent, no duplicate", async () => {
    const a = registry.ensureTenant("foo_pl", "o@foo.pl", "foo.pl", "https://foo.pl");
    const b = registry.ensureTenant("foo_pl", "other@foo.pl", "foo.pl", "https://foo.pl");
    expect(a?.id).toBe("foo_pl");
    expect(b?.email).toBe("o@foo.pl"); // returns existing, not overwritten
    expect(registry.listTenants().filter((t) => t.id === "foo_pl").length).toBe(1);
  });

  it("updateTenant: cache + D1 updated", async () => {
    registry.createTenant("a@x.com", "https://up.com");
    registry.updateTenant("up_com", { status: "active", chunksCount: 42, settings: { theme: "dark" } });
    const rec = registry.getTenant("up_com")!;
    expect(rec.status).toBe("active");
    expect(rec.chunksCount).toBe(42);
    expect(rec.settings.theme).toBe("dark");
    await flush();
    const row = mem.prepare("SELECT * FROM tenants WHERE id=?").get("up_com") as any;
    expect(row.status).toBe("active");
    expect(row.chunks_count).toBe(42);
    expect(JSON.parse(row.settings_json).theme).toBe("dark");
  });

  it("updateTenant: no-op on unknown id", () => {
    expect(() => registry.updateTenant("nope_com", { status: "active" })).not.toThrow();
    expect(registry.getTenant("nope_com")).toBeNull();
  });

  it("listTenants: returns all, newest first", () => {
    registry.createTenant("a@x.com", "https://one.com");
    registry.createTenant("b@x.com", "https://two.com");
    const ids = registry.listTenants().map((t) => t.id);
    expect(ids).toContain("one_com");
    expect(ids).toContain("two_com");
  });

  it("deleteTenant: removed from cache + D1 + session cascade", async () => {
    registry.createTenant("a@x.com", "https://del.com");
    mem.prepare("INSERT INTO sessions (token,tenant_id,expires_at) VALUES (?,?,?)").run("t1", "del_com", "2099-01-01");
    registry.deleteTenant("del_com");
    expect(registry.getTenant("del_com")).toBeNull();
    expect(registry.getTenantByDomain("del.com")).toBeNull();
    await flush();
    expect(mem.prepare("SELECT * FROM tenants WHERE id=?").get("del_com")).toBeUndefined();
    expect(mem.prepare("SELECT * FROM sessions WHERE tenant_id=?").get("del_com")).toBeUndefined();
  });

  it("hydrateRegistry: loads existing D1 rows into the cache", async () => {
    mem.prepare(`INSERT INTO tenants (id,email,domain,site_url,status,created_at,updated_at,qdrant_collection)
      VALUES (?,?,?,?,?,?,?,?)`).run("seed_com", "s@seed.com", "seed.com", "https://seed.com", "active", "2026-01-01", "2026-01-01", "wctx_seed_com");
    expect(registry.getTenant("seed_com")).toBeNull(); // not in cache yet
    const n = await registry.hydrateRegistry();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(registry.getTenant("seed_com")?.email).toBe("s@seed.com");
    expect(registry.getTenantByDomain("seed.com")?.id).toBe("seed_com");
  });
});

describe("migration helpers", () => {
  it("bulkUpsertTenants: writes all records to D1, idempotent", async () => {
    const recs = [
      { id: "m1_com", email: "a@m1.com", domain: "m1.com", siteUrl: "https://m1.com", brandName: null, status: "active" as const, createdAt: "2026-01-01", updatedAt: "2026-01-01", lastScrapedAt: null, pagesCount: 3, chunksCount: 9, qdrantCollection: "wctx_m1_com", settings: {}, ownerPasswordHash: null, apiKey: null, setupToken: null },
      { id: "m2_pl", email: "b@m2.pl", domain: "m2.pl", siteUrl: "https://m2.pl", brandName: "M2", status: "pending" as const, createdAt: "2026-01-02", updatedAt: "2026-01-02", lastScrapedAt: null, pagesCount: 0, chunksCount: 0, qdrantCollection: "wctx_m2_pl", settings: { x: 1 }, ownerPasswordHash: null, apiKey: null, setupToken: null },
    ];
    const r1 = await registry.bulkUpsertTenants(recs);
    expect(r1).toEqual({ ok: 2, fail: 0 });
    expect(await registry.countD1Tenants()).toBe(2);
    // idempotent re-run (INSERT OR REPLACE) — still 2 rows, no error
    const r2 = await registry.bulkUpsertTenants(recs);
    expect(r2).toEqual({ ok: 2, fail: 0 });
    expect(await registry.countD1Tenants()).toBe(2);
    await registry.hydrateRegistry();
    expect(registry.getTenant("m1_com")?.chunksCount).toBe(9);
    expect(registry.getTenant("m2_pl")?.settings.x).toBe(1);
  });
});

describe("d1-auth sessions", () => {
  it("createSession -> validateSession returns tenantId", async () => {
    const token = await auth.createSession("acme_co_uk");
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(await auth.validateSession(token)).toBe("acme_co_uk");
  });

  it("validateSession: unknown token -> null", async () => {
    expect(await auth.validateSession("deadbeef")).toBeNull();
  });

  it("validateSession: expired token -> null + deleted", async () => {
    mem.prepare("INSERT INTO sessions (token,tenant_id,expires_at) VALUES (?,?,?)").run("expired", "t_com", "2000-01-01T00:00:00Z");
    expect(await auth.validateSession("expired")).toBeNull();
    await flush();
    expect(mem.prepare("SELECT * FROM sessions WHERE token=?").get("expired")).toBeUndefined();
  });

  it("password hashing round-trips", () => {
    const h = auth.hashPassword("s3cret");
    expect(auth.verifyPassword("s3cret", h)).toBe(true);
    expect(auth.verifyPassword("wrong", h)).toBe(false);
  });
});
