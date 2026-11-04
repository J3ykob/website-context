/**
 * Password reset (password-reset.ts). The injected "D1" is in-memory SQLite (registry, sessions, quotas) and
 * Resend is a fake that records what would be sent - no network, nobody is e-mailed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

const sent = vi.hoisted(() => [] as any[]);
vi.mock("resend", () => ({
  Resend: class { emails = { send: async (m: any) => { sent.push(m); return { data: { id: "fake" }, error: null }; } }; },
}));

import * as registry from "./d1-registry.js";
import * as auth from "./d1-auth.js";
import * as store from "../storage/conversation-store.js";
import {
  ownerByEmail, mintResetToken, checkResetToken, requestPasswordReset, resetPassword,
  resetsOn, addressConfirmed, setupLinkMark, confirmAddress, ownerCanReset,
} from "./password-reset.js";

let mem: Database.Database;
let failUpdates = false, failNewSessions = false, failSessionDeletes = false;
// Real SQL against SQLite; RETURNING rows come back (the quota counter reads them).
function makeQuery(db: Database.Database) {
  return async (sql: string, params: any[] = []): Promise<any[]> => {
    if (failUpdates && /^\s*UPDATE tenants/i.test(sql)) throw new Error("D1 down");
    if (failNewSessions && /^\s*INSERT INTO sessions/i.test(sql)) throw new Error("D1 down");
    if (failSessionDeletes && /^\s*DELETE FROM sessions/i.test(sql)) throw new Error("D1 down");
    const stmt = db.prepare(sql);
    if (/^\s*select|returning/i.test(sql)) return stmt.all(...params) as any[];
    stmt.run(...params);
    return [];
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const BASE = "https://whisp.so";
const tokenOf = (text: string) => decodeURIComponent(/#reset=([^&\s]+)/.exec(text)![1]);
const quotaRows = () => mem.prepare("SELECT COUNT(*) AS n FROM usage_quota").get();
const later = () => new Date(Date.now() + 1000).toISOString(); // a D1 row newer than the cached record

// An owner as one is made: the set-password link e-mailed to the address (signup keeps setupEmail) is used, which
// confirms the address (setup-password adds setupLinkMark).
function owner(email: string, site: string, password = "old-password-1") {
  const t = registry.createTenant(email, site);
  registry.updateTenant(t.id, { setupToken: "link", settings: { setupEmail: email } });
  const x = registry.getTenant(t.id)!;
  registry.updateTenant(t.id, { ownerPasswordHash: auth.hashPassword(password), setupToken: null, settings: { ...x.settings, ...setupLinkMark(x) } });
  return registry.getTenant(t.id)!;
}

beforeEach(async () => {
  mem = new Database(":memory:");
  // usage_quota/abuse_events here too: quota.ts creates its tables once per process, not per test database.
  mem.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, site_url TEXT NOT NULL,
      brand_name TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_scraped_at TEXT, pages_count INTEGER DEFAULT 0, chunks_count INTEGER DEFAULT 0,
      qdrant_collection TEXT NOT NULL, settings_json TEXT DEFAULT '{}',
      owner_password_hash TEXT, api_key TEXT, setup_token TEXT);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE usage_quota (key TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (key, day));
    CREATE TABLE abuse_events (at TEXT NOT NULL, kind TEXT NOT NULL, key TEXT, tenant_id TEXT, detail TEXT);
  `);
  const q = makeQuery(mem);
  registry.__setQuery(q);
  auth.__setQuery(q);
  store.__setQuery(q);
  failUpdates = false;
  failNewSessions = false;
  failSessionDeletes = false;
  sent.length = 0;
  process.env.ADMIN_SECRET = "test-secret-0123456789abcdef-0123456789";
  delete process.env.PASSWORD_RESET_EMAIL_APPROVED;
  delete process.env.OWNER_EMAILS_PL_APPROVED;
  await registry.hydrateRegistry();
});
afterEach(() => {
  registry.__setQuery(null);
  auth.__setQuery(null);
  store.__setQuery(null);
  mem.close();
});

describe("the account an e-mail opens", () => {
  it("matches case and spaces, and skips a newer business with the same e-mail but no password", async () => {
    const o = owner("jan@firma.pl", "https://firma.pl");
    await new Promise((r) => setTimeout(r, 5));
    registry.createTenant("jan@firma.pl", "https://druga-firma.pl"); // newer, never claimed
    expect(ownerByEmail("  Jan@Firma.PL ")?.id).toBe(o.id);
    expect(ownerByEmail("nobody@firma.pl")).toBeNull();
    expect(ownerByEmail("")).toBeNull();
  });

  it("a newer account whose password was set with its apiKey (no mailbox proved) does not take the owner's place", async () => {
    const o = owner("jan@firma.pl", "https://firma.pl");
    await new Promise((r) => setTimeout(r, 5));
    // A stranger signs up any site with the owner's address and sets the password with the apiKey from the answer.
    const s = owner("Jan@Firma.pl", "https://random-site.com", "stranger-password-1");
    registry.updateTenant(s.id, { settings: { claimedWithApiKey: true } });
    expect(ownerByEmail("jan@firma.pl")?.id).toBe(o.id);
    process.env.PASSWORD_RESET_EMAIL_APPROVED = "1";
    await requestPasswordReset("jan@firma.pl", "en", BASE);
    expect(checkResetToken(tokenOf(sent[0].text))?.id).toBe(o.id);
    registry.deleteTenant(o.id); // alone, it is the account the address opens
    expect(ownerByEmail("jan@firma.pl")?.id).toBe(s.id);
  });
});

describe("reset tokens", () => {
  it("round-trips and names the account", () => {
    const o = owner("a@acme.com", "https://acme.com");
    expect(checkResetToken(mintResetToken(o)!)?.id).toBe(o.id);
  });

  it("rejects tampering, other kinds of token, expiry, a weak secret and accounts without a password", () => {
    const o = owner("a@acme.com", "https://acme.com");
    const other = owner("b@beta.com", "https://beta.com");
    const tok = mintResetToken(o)!;
    const [b64, sig] = tok.split(".");
    const forged = Buffer.from(Buffer.from(b64, "base64url").toString().replace(o.id, other.id)).toString("base64url");
    expect(checkResetToken(`${forged}.${sig}`)).toBeNull();
    expect(checkResetToken(`${b64}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(checkResetToken(b64)).toBeNull();
    expect(checkResetToken(`${Buffer.from(`edit:${o.id}.${Date.now() + 1e6}`).toString("base64url")}.${sig}`)).toBeNull();
    expect(checkResetToken(tok, Date.now() + 61 * 60_000)).toBeNull();
    for (const s of ["", "short", "whisp-admin-2026"]) {
      process.env.ADMIN_SECRET = s;
      expect(mintResetToken(o)).toBeNull();
      expect(checkResetToken(tok)).toBeNull();
    }
    process.env.ADMIN_SECRET = "test-secret-0123456789abcdef-0123456789";
    const unclaimed = registry.createTenant("c@gamma.com", "https://gamma.com");
    expect(mintResetToken(unclaimed)).toBeNull();
  });
});

describe("setting the new password", () => {
  it("works once: the password changes, that link and every older link stop", async () => {
    const o = owner("a@acme.com", "https://acme.com");
    const first = mintResetToken(o)!, second = mintResetToken(o, Date.now() + 1)!;
    const r = await resetPassword(second, "new-password-2");
    expect(r?.tenantId).toBe(o.id);
    expect(await auth.validateSession(r!.token)).toBe(o.id);
    expect(auth.verifyPassword("new-password-2", registry.getTenant(o.id)!.ownerPasswordHash!)).toBe(true);
    await flush();
    const row = mem.prepare("SELECT owner_password_hash FROM tenants WHERE id = ?").get(o.id) as any;
    expect(auth.verifyPassword("new-password-2", row.owner_password_hash)).toBe(true);
    expect(await resetPassword(second, "again-password-3")).toBeNull();
    expect(await resetPassword(first, "again-password-3")).toBeNull();
  });

  it("two requests with the same link at once: exactly one wins", async () => {
    const o = owner("a@acme.com", "https://acme.com");
    const tok = mintResetToken(o)!;
    const out = await Promise.all([resetPassword(tok, "parallel-pass-1"), resetPassword(tok, "parallel-pass-2")]);
    expect(out.filter(Boolean)).toHaveLength(1);
  });

  it("ends every session of the account (owner, admin) and only of that account", async () => {
    const o = owner("a@acme.com", "https://acme.com");
    const other = owner("b@beta.com", "https://beta.com");
    const s1 = await auth.createSession(o.id), s2 = await auth.createSession(o.id), adm = await auth.createSession(o.id, { admin: true });
    const keep = await auth.createSession(other.id);
    const r = await resetPassword(mintResetToken(o)!, "new-password-2");
    for (const s of [s1, s2, adm]) expect(await auth.validateSession(s)).toBeNull();
    expect(await auth.validateSession(keep)).toBe(other.id);
    expect(await auth.validateSession(r!.token)).toBe(o.id);
    expect(r!.signedOut).toBe(true);
  });

  it("sessions that could not be ended: the password is changed, and the answer says the other devices are still in", async () => {
    const o = owner("a@acme.com", "https://acme.com");
    const old = await auth.createSession(o.id);
    failSessionDeletes = true;
    const r = await resetPassword(mintResetToken(o)!, "new-password-2");
    failSessionDeletes = false;
    expect(r?.signedOut).toBe(false);
    expect(await auth.validateSession(old)).toBe(o.id);
    expect(auth.verifyPassword("new-password-2", registry.getTenant(o.id)!.ownerPasswordHash!)).toBe(true);
  });

  it("D1 not taking the password: throws, the old password and the link stay, sessions untouched", async () => {
    const o = owner("a@acme.com", "https://acme.com");
    const s1 = await auth.createSession(o.id);
    const tok = mintResetToken(o)!;
    failUpdates = true;
    await expect(resetPassword(tok, "new-password-2")).rejects.toThrow(/not saved/);
    expect(auth.verifyPassword("old-password-1", registry.getTenant(o.id)!.ownerPasswordHash!)).toBe(true);
    expect(checkResetToken(tok)?.id).toBe(o.id);
    expect(await auth.validateSession(s1)).toBe(o.id);
  });

  it("password saved but no new session: success without a token (the page sends the owner to log in)", async () => {
    const o = owner("a@acme.com", "https://acme.com");
    failNewSessions = true;
    const r = await resetPassword(mintResetToken(o)!, "new-password-2");
    expect(r).toEqual({ token: "", tenantId: o.id, signedOut: true });
    expect(auth.verifyPassword("new-password-2", registry.getTenant(o.id)!.ownerPasswordHash!)).toBe(true);
  });
});

describe("asking for a link", () => {
  it("an address without an owner account: nothing is sent, nothing counted", async () => {
    registry.createTenant("x@unclaimed.com", "https://unclaimed.com");
    await requestPasswordReset("x@unclaimed.com", "en", BASE);
    await requestPasswordReset("nobody@nowhere.com", "en", BASE);
    expect(sent).toHaveLength(0);
    expect(quotaRows()).toEqual({ n: 0 });
  });

  it("the owner gets one e-mail with a working link in the #fragment, in the page's language, which the link carries", async () => {
    const o = owner("kubalol7982@gmail.com", "https://acme.pl");
    await requestPasswordReset(" KubaLOL7982@gmail.com", "pl", BASE);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("kubalol7982@gmail.com");
    expect(sent[0].subject).toBe("Nowe hasło do konta Whisp - acme.pl");
    expect(sent[0].text).not.toContain("{{");
    expect(sent[0].text).toContain(`${BASE}/auth/setup?tenant=${o.id}#reset=`);
    expect(sent[0].text).toMatch(/#reset=[^&\s]+&lang=pl\s/);
    expect(checkResetToken(tokenOf(sent[0].text))?.id).toBe(o.id);
    await requestPasswordReset("kubalol7982@gmail.com", "", BASE); // no page language: as the other owner e-mails (PL not approved -> EN)
    expect(sent[1].subject).toBe("Reset your Whisp password");
    expect(sent[1].text).toMatch(/&lang=en\s/); // the page then reads English too (on its own it picks Polish for *_pl)
    process.env.OWNER_EMAILS_PL_APPROVED = "1";
    await requestPasswordReset("kubalol7982@gmail.com", "", BASE);
    expect(sent[2].subject).toBe("Nowe hasło do konta Whisp - acme.pl");
    expect(sent[2].text).toMatch(/&lang=pl\s/);
  });

  it("until the template is approved, only the Whisp owner's address gets it", async () => {
    owner("owner@example.com", "https://example.com");
    await requestPasswordReset("owner@example.com", "en", BASE);
    expect(sent).toHaveLength(0);
    process.env.PASSWORD_RESET_EMAIL_APPROVED = "1";
    await requestPasswordReset("owner@example.com", "en", BASE);
    expect(sent).toHaveLength(1);
  });

  it("resets off (weak ADMIN_SECRET): nothing sent, none of the owner's e-mails of the day used up", async () => {
    owner("kubalol7982@gmail.com", "https://acme.com");
    process.env.ADMIN_SECRET = "short";
    await requestPasswordReset("kubalol7982@gmail.com", "en", BASE);
    expect(sent).toHaveLength(0);
    expect(quotaRows()).toEqual({ n: 0 });
  });

  it("resets reach owners only once the e-mail is approved and the secret is strong (the page says so otherwise)", () => {
    expect(resetsOn()).toBe(false);
    process.env.PASSWORD_RESET_EMAIL_APPROVED = "1";
    expect(resetsOn()).toBe(true);
    process.env.ADMIN_SECRET = "whisp-admin-2026";
    expect(resetsOn()).toBe(false);
  });

  it("at most 3 e-mails per address per day", async () => {
    owner("kubalol7982@gmail.com", "https://acme.com");
    for (let i = 0; i < 4; i++) await requestPasswordReset("kubalol7982@gmail.com", "en", BASE);
    expect(sent).toHaveLength(3);
  });
});

describe("only a confirmed address gets a link", () => {
  it("a set-password link confirms the address it was e-mailed to, while that is still the account's", () => {
    const t = registry.createTenant("Owner@Acme.pl ", "https://acme.pl");
    registry.updateTenant(t.id, { settings: { setupEmail: "owner@acme.pl" } });
    const x = registry.getTenant(t.id)!;
    expect(setupLinkMark(x)).toEqual({ confirmedEmail: "owner@acme.pl" });
    expect(setupLinkMark({ ...x, settings: {} })).toEqual({}); // a link from before 2026-11: nothing kept with it
    expect(setupLinkMark({ ...x, settings: { setupEmail: "other@acme.pl" } })).toEqual({});
  });

  it("an owner whose address was never confirmed (claimed before 2026-11) gets nothing until a login with it", async () => {
    const t = registry.createTenant("jan@firma.pl", "https://firma.pl");
    registry.updateTenant(t.id, { ownerPasswordHash: auth.hashPassword("owner-password-1") });
    process.env.PASSWORD_RESET_EMAIL_APPROVED = "1";
    await requestPasswordReset("jan@firma.pl", "en", BASE);
    expect(sent).toHaveLength(0);
    expect(quotaRows()).toEqual({ n: 0 });
    confirmAddress(registry.getTenant(t.id)!); // POST /api/auth/login with the password
    await flush();
    const row = mem.prepare("SELECT settings_json FROM tenants WHERE id = ?").get(t.id) as any;
    expect(JSON.parse(row.settings_json).confirmedEmail).toBe("jan@firma.pl");
    await requestPasswordReset("jan@firma.pl", "en", BASE);
    expect(sent).toHaveLength(1);
  });

  it("an address rewritten before 2026-11 (the public onboard-demo form) never gets a link, even after the old link claims the account", async () => {
    // Signup before 2026-11: the welcome e-mail took the link to owner@acme.pl; nothing kept the address with it.
    const t = registry.createTenant("owner@acme.pl", "https://acme.pl");
    registry.updateTenant(t.id, { setupToken: "old-link" });
    await flush();
    // The old /api/onboard-demo wrote a stranger's address over it, and the link lived on.
    mem.prepare("UPDATE tenants SET email = ?, updated_at = ? WHERE id = ?").run("stranger@evil.example", later(), t.id);
    await registry.hydrateRegistry();
    expect(registry.getTenant(t.id)).toMatchObject({ email: "stranger@evil.example", setupToken: "old-link" });
    // The owner uses the old link (setup-password: the token matches; setupLinkMark adds what it confirms - nothing).
    const x = registry.getTenant(t.id)!;
    registry.updateTenant(t.id, { ownerPasswordHash: auth.hashPassword("owner-password-1"), setupToken: null, settings: { ...x.settings, ...setupLinkMark(x) } });
    expect(addressConfirmed(registry.getTenant(t.id)!)).toBe(false);
    process.env.PASSWORD_RESET_EMAIL_APPROVED = "1";
    await requestPasswordReset("stranger@evil.example", "en", BASE);
    expect(sent).toHaveLength(0);
  });

  it("an owner's address corrected later (support, in D1) gets a link only once the owner logs in with it", async () => {
    const o = owner("jan@firma.pl", "https://firma.pl");
    await flush();
    mem.prepare("UPDATE tenants SET email = ?, updated_at = ? WHERE id = ?").run("jan.nowak@firma.pl", later(), o.id);
    await registry.hydrateRegistry();
    process.env.PASSWORD_RESET_EMAIL_APPROVED = "1";
    await requestPasswordReset("jan.nowak@firma.pl", "en", BASE);
    expect(sent).toHaveLength(0);
    confirmAddress(registry.getTenant(o.id)!);
    await requestPasswordReset("jan.nowak@firma.pl", "en", BASE);
    expect(sent).toHaveLength(1);
  });

  it("whether an owner gets back in alone (the lead page's rule): resets on, the address confirmed, a login opens this business", async () => {
    const o = owner("jan@firma.pl", "https://firma.pl");
    expect(ownerCanReset(o)).toBe(false); // the e-mail is not approved yet
    process.env.PASSWORD_RESET_EMAIL_APPROVED = "1";
    expect(ownerCanReset(o)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const newer = owner("jan@firma.pl", "https://druga-firma.pl");
    expect(ownerCanReset(registry.getTenant(o.id)!)).toBe(false); // a login with the address opens the newer one
    expect(ownerCanReset(newer)).toBe(true);
    const unconfirmed = registry.createTenant("ewa@trzecia.pl", "https://trzecia.pl");
    registry.updateTenant(unconfirmed.id, { ownerPasswordHash: auth.hashPassword("owner-password-1") });
    expect(ownerCanReset(registry.getTenant(unconfirmed.id)!)).toBe(false);
    expect(ownerCanReset(registry.createTenant("x@czwarta.pl", "https://czwarta.pl"))).toBe(false); // no password
  });
});

describe("an address put on an account before it is claimed", () => {
  it("ends the set-password link and the apiKey sent for the old address: no claim, no reset link to the new one", async () => {
    // Signup (POST /api/tenants): the welcome e-mail takes the link to owner@acme.pl; the answer has the apiKey.
    const t = registry.createTenant("owner@acme.pl", "https://acme.pl");
    registry.updateTenant(t.id, { apiKey: "key-from-the-signup-answer", setupToken: "link-from-the-welcome-email" });
    // While it is pending (or broken), POST /api/onboard-demo {siteUrl: "acme.pl", email} changes the address.
    registry.updateTenant(t.id, { email: "attacker@evil.example" });
    // The owner opens the welcome link: setup-password's check (scripts/serve-multi-tenant.ts) finds no token to match.
    const claim = (token: string) => {
      const x = registry.getTenant(t.id)!;
      if (!x.setupToken || x.setupToken !== token || x.ownerPasswordHash) return false;
      registry.updateTenant(t.id, { ownerPasswordHash: auth.hashPassword("owner-password-1"), setupToken: null });
      return true;
    };
    expect(claim("link-from-the-welcome-email")).toBe(false);
    expect(registry.getTenant(t.id)!.apiKey).toBeNull();
    await flush();
    expect(mem.prepare("SELECT setup_token, api_key FROM tenants WHERE id = ?").get(t.id)).toEqual({ setup_token: null, api_key: null });
    process.env.PASSWORD_RESET_EMAIL_APPROVED = "1";
    await requestPasswordReset("attacker@evil.example", "en", BASE);
    expect(sent).toHaveLength(0);
  });
});

describe("registry refresh during a write", () => {
  it("a refresh whose snapshot predates the write keeps the new value", async () => {
    const o = owner("a@acme.com", "https://acme.com");
    await flush();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const q = makeQuery(mem);
    registry.__setQuery(async (sql, p) => { if (/^\s*UPDATE tenants/i.test(sql)) await gate; return q(sql, p); });
    await registry.hydrateRegistry(); // cache re-filled (the seam swap cleared it)
    const saved = registry.updateTenant(o.id, { ownerPasswordHash: auth.hashPassword("new-password-2") });
    await registry.hydrateRegistry(); // its SELECT runs before the UPDATE lands
    expect(auth.verifyPassword("new-password-2", registry.getTenant(o.id)!.ownerPasswordHash!)).toBe(true);
    release();
    expect(await saved).toBe(true);
    await registry.hydrateRegistry();
    expect(auth.verifyPassword("new-password-2", registry.getTenant(o.id)!.ownerPasswordHash!)).toBe(true);
  });
});
