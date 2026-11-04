/**
 * Password reset for business owners ("Forgot password?" on /auth/login).
 *
 * The link's token is signed, not stored: an HMAC over "reset:<tenantId>.<expiry>" and the account's CURRENT
 * password hash, with a key of its own derived from ADMIN_SECRET. Setting the new password changes the hash, so
 * a link works once and every older link stops with it; it also stops at its expiry. Only an account that has a
 * password (an owner) is reset - claiming an account stays the set-password e-mail (setup token).
 */
import { createHmac, timingSafeEqual } from "crypto";
import { getTenant, listTenants, updateTenant, type TenantRecord } from "./d1-registry.js";
import { hashPassword, createSession, revokeSessions } from "./d1-auth.js";

export const resetTtlMinutes = (): number => Number(process.env.PASSWORD_RESET_TTL_MIN) || 60;
const norm = (e: unknown) => String(e || "").trim().toLowerCase();

// A key of its own: the raw ADMIN_SECRET also signs chat history and relay tokens handed to clients
// (src/security/history-sig.ts, src/voice/relay-token.ts). Unset/weak/default secret = no resets (fail closed, as adminOk).
function resetKey(): Buffer | null {
  const s = process.env.ADMIN_SECRET || "";
  if (s.length < 24 || s === "whisp-admin-2026") return null;
  return createHmac("sha256", s).update("password-reset-v1").digest();
}
const sign = (key: Buffer, payload: string, hash: string) => createHmac("sha256", key).update(`${payload}|${hash}`).digest("base64url");

/**
 * The account a login with this e-mail opens, and a reset sets: the newest business with this address that has a
 * password. One whose password was set with its apiKey (settings.claimedWithApiKey) comes after the others: the key
 * goes to whoever signs up, with any address typed, so it proves no mailbox - a stranger's account carrying an
 * owner's address took the owner's login and reset (reproduced in password-reset.test.ts).
 */
export function ownerByEmail(email: unknown): TenantRecord | null {
  const e = norm(email);
  const owners = e ? listTenants().filter((t) => !!t.ownerPasswordHash && norm(t.email) === e) : [];
  return owners.find((t) => !t.settings?.claimedWithApiKey) || owners[0] || null;
}

export function mintResetToken(t: TenantRecord, now = Date.now()): string | null {
  const key = resetKey();
  if (!key || !t.ownerPasswordHash) return null;
  const payload = `reset:${t.id}.${now + resetTtlMinutes() * 60_000}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(key, payload, t.ownerPasswordHash)}`;
}

/** The account a reset token is for, or null: forged, expired, already used (the password changed since), no password. */
export function checkResetToken(token: string, now = Date.now()): TenantRecord | null {
  const key = resetKey(), dot = token.lastIndexOf(".");
  if (!key || dot <= 0) return null;
  const payload = Buffer.from(token.slice(0, dot), "base64url").toString();
  const i = payload.lastIndexOf(".");
  if (!payload.startsWith("reset:") || i < 7) return null;
  const t = getTenant(payload.slice(6, i)), exp = Number(payload.slice(i + 1));
  if (!t?.ownerPasswordHash || !Number.isFinite(exp) || exp < now) return null;
  const want = Buffer.from(sign(key, payload, t.ownerPasswordHash)), got = Buffer.from(token.slice(dot + 1));
  return want.length === got.length && timingSafeEqual(want, got) ? t : null;
}

/**
 * "Forgot password?": e-mails a reset link to the owner of this address, if there is one. Called after the
 * request has been answered - the answer and its timing are the same for every address.
 */
export async function requestPasswordReset(email: string, lang: string, baseUrl: string): Promise<void> {
  const t = ownerByEmail(email);
  if (!t) return;
  // Signed before it is counted: with resets off, a request must not use up one of the owner's e-mails of the day.
  const token = mintResetToken(t);
  if (!token) { console.error("[auth] password reset off: ADMIN_SECRET is unset or weak"); return; }
  const { bump, logAbuse } = await import("../security/quota.js");
  if (!(await bump(`pwreset:email:${norm(t.email)}`, Number(process.env.PASSWORD_RESET_PER_DAY) || 3))) {
    logAbuse("password_reset_cap", `email:${norm(t.email)}`, t.id);
    return;
  }
  const { sendPasswordResetEmail } = await import("./email.js");
  // The token rides in the #fragment: a browser never sends it to a server (no access logs, no Referer).
  await sendPasswordResetEmail(t.email, {
    domain: t.domain, lang, minutes: resetTtlMinutes(),
    resetUrl: `${baseUrl}/auth/setup?tenant=${encodeURIComponent(t.id)}#reset=${encodeURIComponent(token)}`,
  });
}

/**
 * A new password from a reset link: every session of the account ends and a new one is returned. Null when the
 * link is not valid; throws when D1 did not take the new password (the old one stays, the link still works).
 * signedOut false = the old sessions could not be ended (D1 failed twice): they stay valid for up to their 7 days,
 * so the page says it instead of promising it.
 */
export async function resetPassword(token: string, password: string): Promise<{ token: string; tenantId: string; signedOut: boolean } | null> {
  const t = checkResetToken(token);
  if (!t) return null;
  const old = t.ownerPasswordHash;
  // No await between the check and the cache update: a second request with the same link already sees the new hash.
  const saved = updateTenant(t.id, { ownerPasswordHash: hashPassword(password) });
  if (!(await saved)) {
    updateTenant(t.id, { ownerPasswordHash: old });
    throw new Error(`${t.id}: new password not saved to D1`);
  }
  const signedOut = await revokeSessions(t.id).catch(() => revokeSessions(t.id)).then(() => true, (e) => {
    console.error(`[auth] ${t.id}: sessions NOT ended after a password reset: ${(e as Error).message}`);
    return false;
  });
  // The password is changed now: without a new session the page sends the owner to log in with it.
  const session = await createSession(t.id).catch((e) => {
    console.error(`[auth] ${t.id}: no new session after a password reset (sent to log in): ${(e as Error).message}`);
    return "";
  });
  return { token: session, tenantId: t.id, signedOut };
}
