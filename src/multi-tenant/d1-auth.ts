/**
 * Auth backed by Cloudflare D1. Sessions live in D1 (durable, cross-instance) and
 * are validated per-request (async) — never cached stale. Password hashing / API
 * key generation are pure (no DB). The D1 query is injectable for tests.
 */

import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";

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
/** Test seam: inject a fake D1 query. */
export function __setQuery(fn: QueryFn | null): void {
  query = fn || realQuery;
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}
export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}
export function generateApiKey(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Create a 7-day session for a tenant; stored in D1. An admin's session (support) is marked "adm-". A session opened
 * by switching sites (src/multi-tenant/sites.ts) carries the account the owner logged in to (`via`): the site switched
 * to may have no password of its own, and the way back is judged by that account. The token is ours and looked up
 * whole, so what it carries cannot be made up by a client.
 */
export async function createSession(tenantId: string, opts: { admin?: boolean; via?: string } = {}): Promise<string> {
  const via = opts.via ? `via.${Buffer.from(opts.via).toString("base64url")}.` : "";
  const token = `${opts.admin ? "adm-" : ""}${via}${randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await query("INSERT INTO sessions (token, tenant_id, expires_at) VALUES (?, ?, ?)", [token, tenantId, expiresAt]);
  return token;
}

/** The account a switched session came from (createSession `via`), or null for a login's own session. */
export function sessionOrigin(token: string): string | null {
  const t = token.startsWith("adm-") ? token.slice(4) : token;
  if (!t.startsWith("via.")) return null;
  const enc = t.split(".")[1] || "";
  try { return Buffer.from(enc, "base64url").toString("utf-8") || null; } catch { return null; }
}

/** Validate a session token; returns tenantId or null. Deletes expired tokens. */
export async function validateSession(token: string): Promise<string | null> {
  const rows = await query("SELECT tenant_id, expires_at FROM sessions WHERE token = ?", [token]);
  const row = rows[0] as { tenant_id: string; expires_at: string } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    query("DELETE FROM sessions WHERE token = ?", [token]).catch(() => {}); // best-effort cleanup
    return null;
  }
  return row.tenant_id;
}

/** Ends every session of a business - the owner's, a lead-page one, an admin's support session (password reset). */
export async function revokeSessions(tenantId: string): Promise<void> {
  await query("DELETE FROM sessions WHERE tenant_id = ?", [tenantId]);
}
