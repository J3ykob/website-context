/**
 * Password reset for business owners ("Forgot password?" on /auth/login).
 *
 * The link's token is signed, not stored: an HMAC over "reset:<tenantId>.<expiry>" and the account's CURRENT
 * password hash, with a key of its own derived from ADMIN_SECRET. Setting the new password changes the hash, so
 * a link works once and every older link stops with it; it also stops at its expiry. Only an account that has a
 * password (an owner) is reset - claiming an account stays the set-password e-mail (setup token).
 *
 * A link goes only to the account's CONFIRMED address (settings.confirmedEmail): the one its set-password link was
 * e-mailed to, once that link is used, or the one its owner logs in with. Before 2026-11 the public /api/onboard-demo
 * form and a lead-page payment rewrote the address of accounts that already had an owner (security review
 * 2026-11-04): a link to such an address would hand the account to whoever reads that mailbox. Only the owner logs
 * in, and the owner does not log in with a stranger's address, so a rewritten address is never confirmed.
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
 * Whether a reset e-mail can reach owners at all: a reset key, and the e-mail approved (until then email.ts sends it
 * only to the Whisp owner's own address). Global, so saying it on the login page tells nothing about any account.
 */
export const resetsOn = (): boolean => !!resetKey() && process.env.PASSWORD_RESET_EMAIL_APPROVED === "1";

/** The account's address is the one its owner confirmed: a reset link may go there. */
export function addressConfirmed(t: TenantRecord): boolean {
  const c = norm(t.settings?.confirmedEmail);
  return !!c && c === norm(t.email);
}

/**
 * What using the set-password link adds to the settings of the account it claims: the address the link was e-mailed
 * to (settings.setupEmail, kept by signup and admin handover) is confirmed, while it is still the account's (a new
 * address ends the link - updateTenant). A link from before 2026-11 has no setupEmail and confirms nothing: the
 * address could have been rewritten after it was sent.
 */
export function setupLinkMark(t: TenantRecord): { confirmedEmail?: string } {
  const sentTo = norm(t.settings?.setupEmail);
  return sentTo && sentTo === norm(t.email) ? { confirmedEmail: sentTo } : {};
}

/** A login with the password confirms the address it was made with (an account claimed before 2026-11 gets it here). */
export function confirmAddress(t: TenantRecord): void {
  if (!t.ownerPasswordHash || addressConfirmed(t)) return;
  updateTenant(t.id, { settings: { ...(t.settings || {}), confirmedEmail: norm(t.email) } });
}

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

/**
 * Whether the owner of this business gets back in alone: resets are on, a login with its address opens this business
 * (not a newer one with the same address), and its address is confirmed, so "Forgot password?" works for it.
 * The lead page's dashboard button sends such a business to the login (src/projects/lead.ts).
 */
export function ownerCanReset(t: TenantRecord): boolean {
  return !!t.ownerPasswordHash && resetsOn() && addressConfirmed(t) && ownerByEmail(t.email)?.id === t.id;
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
  if (!addressConfirmed(t)) {
    console.log(`[auth] ${t.id}: password reset not sent - its address is not confirmed yet (no set-password link used, or login, with it)`);
    return;
  }
  // Signed before it is counted: with resets off, a request must not use up one of the owner's e-mails of the day.
  const token = mintResetToken(t);
  if (!token) { console.error("[auth] password reset off: ADMIN_SECRET is unset or weak"); return; }
  const { bump, logAbuse } = await import("../security/quota.js");
  if (!(await bump(`pwreset:email:${norm(t.email)}`, Number(process.env.PASSWORD_RESET_PER_DAY) || 3))) {
    logAbuse("password_reset_cap", `email:${norm(t.email)}`, t.id);
    return;
  }
  const { sendPasswordResetEmail, ownerLang } = await import("./email.js");
  // The e-mail's language (the login page's, else as the other owner e-mails) rides in the link too: the reset page
  // then reads as the e-mail did. On its own it picks Polish for any .pl business, after an English e-mail too.
  const l = lang === "pl" || lang === "en" ? lang : ownerLang(t.domain);
  // The token rides in the #fragment: a browser never sends it to a server (no access logs, no Referer).
  await sendPasswordResetEmail(t.email, {
    domain: t.domain, lang: l, minutes: resetTtlMinutes(),
    resetUrl: `${baseUrl}/auth/setup?tenant=${encodeURIComponent(t.id)}#reset=${encodeURIComponent(token)}&lang=${l}`,
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
