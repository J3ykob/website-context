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

  it("updateTenant: a new e-mail ends the set-password link and the apiKey, unless the same write issues new ones", async () => {
    registry.createTenant("Owner@Acme.pl", "https://acme.pl");
    registry.updateTenant("acme_pl", { apiKey: "k1", setupToken: "link-1" });
    registry.updateTenant("acme_pl", { email: " owner@acme.pl" }); // the same mailbox, typed differently
    expect(registry.getTenant("acme_pl")).toMatchObject({ apiKey: "k1", setupToken: "link-1" });
    registry.updateTenant("acme_pl", { email: "new@acme.pl", setupToken: "link-2" }); // admin handover
    expect(registry.getTenant("acme_pl")).toMatchObject({ email: "new@acme.pl", apiKey: null, setupToken: "link-2" });
    registry.updateTenant("acme_pl", { email: "someone@else.pl" }); // /api/onboard-demo, a lead-page payment
    expect(registry.getTenant("acme_pl")).toMatchObject({ email: "someone@else.pl", apiKey: null, setupToken: null });
    await flush();
    expect(mem.prepare("SELECT email, api_key, setup_token FROM tenants WHERE id=?").get("acme_pl"))
      .toEqual({ email: "someone@else.pl", api_key: null, setup_token: null });
  });

  it("updateTenant: an account with a password keeps its e-mail, whatever a write asks (the rest of the write goes on)", async () => {
    registry.createTenant("owner@acme.pl", "https://acme.pl");
    registry.updateTenant("acme_pl", { ownerPasswordHash: "hash-1" });
    registry.updateTenant("acme_pl", { email: "stranger@evil.example", status: "pending" }); // the old /api/onboard-demo write
    expect(registry.getTenant("acme_pl")).toMatchObject({ email: "owner@acme.pl", status: "pending" });
    registry.updateTenant("acme_pl", { email: "payer@else.pl" }); // a lead-page payment, nothing else in the write
    expect(registry.getTenant("acme_pl")!.email).toBe("owner@acme.pl");
    registry.updateTenant("acme_pl", { email: " Owner@Acme.pl" }); // the same mailbox, typed differently
    expect(registry.getTenant("acme_pl")!.email).toBe(" Owner@Acme.pl");
    await flush();
    expect(mem.prepare("SELECT email, status FROM tenants WHERE id=?").get("acme_pl")).toEqual({ email: " Owner@Acme.pl", status: "pending" });
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

// A result waits for an owner only when the business has one (2026-11-04 eval: calculations on demos nobody
// had claimed were held for approval and never arrived; the review e-mail goes to the demo's address).
describe("owner account: a demo nobody has claimed vs. a business with an owner", () => {
  afterEach(() => {
    delete process.env.AGENT_REVIEW_FORCE;
    delete process.env.AGENT_OWNER_FORCE;
  });

  it("hasOwnerAccount: a set password or a stored subscription, nothing else", () => {
    registry.createTenant("claim@whisp.so", "https://demo.pl");
    expect(registry.hasOwnerAccount("demo_pl")).toBe(false);
    expect(registry.hasOwnerAccount("unknown_pl")).toBe(false);
    registry.updateTenant("demo_pl", { settings: { agentReview: "approve", stripeCustomer: "cus_1" } });
    expect(registry.hasOwnerAccount("demo_pl")).toBe(false); // a setting or a Stripe customer is not an owner
    registry.updateTenant("demo_pl", { ownerPasswordHash: auth.hashPassword("s3cret-pass") });
    expect(registry.hasOwnerAccount("demo_pl")).toBe(true);
    // A subscriber without a password (the lead-page checkout stores only the subscription).
    registry.createTenant("payer@firma.pl", "https://firma.pl");
    registry.updateTenant("firma_pl", { settings: { stripeCustomer: "cus_2", stripeSubscription: "sub_2" } });
    expect(registry.hasOwnerAccount("firma_pl")).toBe(true);
  });

  it("reviewMode: a stored approve waits for the claim; owners keep their choice", async () => {
    const { reviewMode, hasReviewer } = await import("../projects/review.js");
    registry.createTenant("claim@whisp.so", "https://demo.pl");
    registry.updateTenant("demo_pl", { settings: { agentReview: "approve" } });
    expect(hasReviewer("demo_pl")).toBe(false);
    expect(reviewMode("demo_pl")).toBe("auto");
    registry.updateTenant("demo_pl", { ownerPasswordHash: auth.hashPassword("s3cret-pass") });
    expect(hasReviewer("demo_pl")).toBe(true);
    expect(reviewMode("demo_pl")).toBe("approve");

    registry.createTenant("payer@firma.pl", "https://firma.pl");
    registry.updateTenant("firma_pl", { settings: { agentReview: "approve", stripeSubscription: "sub_2" } });
    expect(reviewMode("firma_pl")).toBe("approve");
    registry.updateTenant("firma_pl", { settings: { stripeSubscription: "sub_2" } });
    expect(reviewMode("firma_pl")).toBe("auto"); // owned, its own choice: auto
  });

  it("live-test knobs: AGENT_REVIEW_FORCE = approve, AGENT_OWNER_FORCE = an owner under its own setting", async () => {
    const { reviewMode, hasReviewer } = await import("../projects/review.js");
    registry.createTenant("claim@whisp.so", "https://demo.pl");
    registry.createTenant("claim@whisp.so", "https://other.pl");
    process.env.AGENT_REVIEW_FORCE = "other_pl,demo_pl";
    expect(hasReviewer("demo_pl")).toBe(true);
    expect(reviewMode("demo_pl")).toBe("approve");
    delete process.env.AGENT_REVIEW_FORCE;

    process.env.AGENT_OWNER_FORCE = "demo_pl";
    expect(hasReviewer("demo_pl")).toBe(true);
    expect(reviewMode("demo_pl")).toBe("auto"); // nothing stored
    registry.updateTenant("demo_pl", { settings: { agentReview: "approve" } });
    expect(reviewMode("demo_pl")).toBe("approve");
    expect(hasReviewer("other_pl")).toBe(false); // only the listed ids
    expect(hasReviewer("")).toBe(false); // "".split(",") is [""]
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
