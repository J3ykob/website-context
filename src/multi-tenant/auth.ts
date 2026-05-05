/**
 * Authentication utilities — password hashing, sessions, API keys.
 */

import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { getDb } from "./db/connection.js";
import { runMigrations } from "./db/migrations.js";

let migrated = false;
function ensureMigrated(): void {
  if (!migrated) {
    runMigrations();
    migrated = true;
  }
}

/**
 * Hash a password using bcryptjs.
 */
export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

/**
 * Verify a password against a bcryptjs hash.
 */
export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

/**
 * Create a session for a tenant — generates random token, stores in sessions table, 7-day expiry.
 */
export function createSession(tenantId: string): string {
  ensureMigrated();
  const db = getDb();

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO sessions (token, tenant_id, expires_at)
    VALUES (?, ?, ?)
  `).run(token, tenantId, expiresAt);

  return token;
}

/**
 * Validate a session token — returns tenantId or null if invalid/expired.
 */
export function validateSession(token: string): string | null {
  ensureMigrated();
  const db = getDb();

  const row = db.prepare(
    "SELECT tenant_id, expires_at FROM sessions WHERE token = ?"
  ).get(token) as { tenant_id: string; expires_at: string } | undefined;

  if (!row) return null;

  // Check expiry
  if (new Date(row.expires_at) < new Date()) {
    // Clean up expired session
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }

  return row.tenant_id;
}

/**
 * Generate a random 32-char hex API key.
 */
export function generateApiKey(): string {
  return randomBytes(16).toString("hex");
}
