/**
 * The lead page's ways into a business's account (lead.ts): the payment, which can give the account the payer's
 * address, and the dashboard button. The injected "D1" is in-memory SQLite and Stripe is a stubbed fetch that
 * answers like a paid Checkout session - no network, nothing is charged or e-mailed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import * as registry from "../multi-tenant/d1-registry.js";
import * as auth from "../multi-tenant/d1-auth.js";
import * as store from "../storage/conversation-store.js";
import { confirmCheckout, dashboardSession } from "./lead.js";

let mem: Database.Database;
const payers = new Map<string, string>(); // Checkout session id -> the address the payer typed at Stripe

function makeQuery(db: Database.Database) {
  return async (sql: string, params: any[] = []): Promise<any[]> => {
    const stmt = db.prepare(sql);
    if (/^\s*select|returning/i.test(sql)) return stmt.all(...params) as any[];
    stmt.run(...params);
    return [];
  };
}
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });

beforeAll(async () => {
  mem = new Database(":memory:");
  // network_invites here: lead.ts creates it once per process, and a row is needed before its first query.
  mem.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, site_url TEXT NOT NULL,
      brand_name TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_scraped_at TEXT, pages_count INTEGER DEFAULT 0, chunks_count INTEGER DEFAULT 0,
      qdrant_collection TEXT NOT NULL, settings_json TEXT DEFAULT '{}',
      owner_password_hash TEXT, api_key TEXT, setup_token TEXT);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE network_invites (tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, token TEXT NOT NULL, emailed INTEGER NOT NULL,
      created_at TEXT NOT NULL, unlocked_at TEXT, passed_at TEXT, replied_at TEXT, PRIMARY KEY (tenant_id, project_id));
  `);
  const q = makeQuery(mem);
  registry.__setQuery(q);
  auth.__setQuery(q);
  store.__setQuery(q);
  await registry.hydrateRegistry();
  process.env.STRIPE_SECRET_KEY = "sk_test_offline_stub";
  // Stripe: a Checkout session "cs_<invite token>" is complete and paid; every subscription is active.
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    const path = u.startsWith("https://api.stripe.com/v1/") ? u.slice("https://api.stripe.com/v1".length) : "";
    if (path.startsWith("/checkout/sessions/")) {
      const id = decodeURIComponent(path.slice("/checkout/sessions/".length));
      return json({ metadata: { token: id.slice(3) }, status: "complete", payment_status: "paid", customer: "cus_1", subscription: "sub_1", customer_details: { email: payers.get(id) } });
    }
    if (path.startsWith("/subscriptions/")) return json({ status: "active" });
    throw new Error(`network blocked: ${u}`);
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.STRIPE_SECRET_KEY;
  registry.__setQuery(null);
  auth.__setQuery(null);
  store.__setQuery(null);
  mem.close();
});

/** A business with an invite to a network request, paid on its lead page by `payer`. */
async function paid(email: string, site: string, payer: string, password?: string) {
  const t = registry.createTenant(email, site);
  registry.updateTenant(t.id, { apiKey: "key-1", setupToken: "link-1", ...(password ? { ownerPasswordHash: auth.hashPassword(password) } : {}) });
  const token = `inv-${t.id}`;
  mem.prepare("INSERT INTO network_invites (tenant_id, project_id, token, emailed, created_at) VALUES (?, ?, ?, 1, ?)").run(t.id, `p-${t.id}`, token, new Date().toISOString());
  payers.set(`cs_${token}`, payer);
  expect(await confirmCheckout(token, `cs_${token}`)).toBe(true);
  return { id: t.id, token };
}

describe("a payment on the lead page", () => {
  it("an account nobody has claimed takes the payer's address, and the set-password link sent to the old one ends", async () => {
    const { id } = await paid("biuro@firma.pl", "https://firma.pl", "payer@firma.pl");
    expect(registry.getTenant(id)).toMatchObject({ email: "payer@firma.pl", setupToken: null, apiKey: null });
    expect(registry.getTenant(id)!.settings.stripeSubscription).toBe("sub_1");
  });

  it("an account whose owner has set a password keeps the owner's login e-mail (where a reset link goes)", async () => {
    const { id } = await paid("owner@beta.pl", "https://beta.pl", "someone@else.pl", "owner-password-1");
    expect(registry.getTenant(id)!.email).toBe("owner@beta.pl");
    expect(registry.getTenant(id)!.settings.stripeSubscription).toBe("sub_1");
  });
});

describe("the dashboard button on the lead page", () => {
  it("opens a session for an account without a password", async () => {
    const { id, token } = await paid("biuro@gamma.pl", "https://gamma.pl", "biuro@gamma.pl");
    const s = await dashboardSession(token);
    expect(s && "token" in s ? await auth.validateSession(s.token) : null).toBe(id);
  });

  it("sends an owner who can reset the password alone to the login, and opens no session", async () => {
    const { id, token } = await paid("owner@delta.pl", "https://delta.pl", "owner@delta.pl", "owner-password-1");
    registry.updateTenant(id, { settings: { ...registry.getTenant(id)!.settings, confirmedEmail: "owner@delta.pl" } }); // claimed with its e-mailed link
    await withResetsOn(async () => {
      expect(await dashboardSession(token)).toEqual({ login: true });
      expect(mem.prepare("SELECT COUNT(*) AS n FROM sessions WHERE tenant_id = ?").get(id)).toEqual({ n: 0 });
    });
  });

  it("still opens the panel for an owner with a password while no reset is possible: not approved yet, an address not confirmed", async () => {
    const { id, token } = await paid("owner@epsilon.pl", "https://epsilon.pl", "owner@epsilon.pl", "owner-password-1");
    const opens = async () => { const s = await dashboardSession(token); return s && "token" in s ? auth.validateSession(s.token) : null; };
    vi.stubEnv("ADMIN_SECRET", "test-secret-0123456789abcdef-0123456789");
    vi.stubEnv("PASSWORD_RESET_EMAIL_APPROVED", "0");
    try {
      expect(await opens()).toBe(id); // the reset e-mail not approved: "Forgot password?" e-mails nobody yet
    } finally {
      vi.unstubAllEnvs();
    }
    await withResetsOn(async () => expect(await opens()).toBe(id)); // approved, but claimed before addresses were confirmed
  });
});

/** Resets on (a strong secret, the e-mail approved) for the time of `fn`; the environment is put back after. */
async function withResetsOn(fn: () => Promise<void>) {
  vi.stubEnv("ADMIN_SECRET", "test-secret-0123456789abcdef-0123456789");
  vi.stubEnv("PASSWORD_RESET_EMAIL_APPROVED", "1");
  try { await fn(); } finally { vi.unstubAllEnvs(); }
}
