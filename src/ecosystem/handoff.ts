/**
 * Hand-off links between businesses' bots. When a bot recommends another
 * business (answerViaPartner), each recommended business gets a link
 * (/h/<token>) that moves the customer to that business's bot with the
 * conversation so far: its widget shows the earlier messages and answers the
 * customer's need itself. No bot relays for another - one LLM on the path.
 *
 * The token is random and unguessable (not derived from any id), and expires;
 * the row keeps the conversation only for that long. opened_at / opens record
 * the click-through (referral accounting).
 */
import { randomBytes } from "crypto";
import { d1Query } from "../storage/conversation-store.js";

export interface HandoffTurn { role: "user" | "assistant"; content: string }
export interface Handoff {
  token: string;
  fromTenant: string;
  fromLabel: string;
  toTenant: string;
  transcript: HandoffTurn[];
  need: string;
}

const TTL_MS = 24 * 60 * 60 * 1000;
export const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await d1Query("CREATE TABLE IF NOT EXISTS handoffs (token TEXT PRIMARY KEY, from_tenant TEXT NOT NULL, from_label TEXT, to_tenant TEXT NOT NULL, transcript TEXT NOT NULL, need TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, opened_at TEXT, opens INTEGER DEFAULT 0)");
  schemaReady = true;
}

/** One link per recommended business; returns tenantId -> token. */
export async function createHandoffs(
  from: { tenantId: string; label: string },
  targets: { tenantId: string }[],
  transcript: HandoffTurn[],
  need: string,
): Promise<Record<string, string>> {
  await ensureSchema();
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_MS).toISOString();
  // What the next bot needs and nothing more: the last turns, trimmed.
  const turns = JSON.stringify(transcript.slice(-8).map((t) => ({ role: t.role, content: String(t.content).slice(0, 1500) })));
  const out: Record<string, string> = {};
  await Promise.all(targets.map(async (t) => {
    const token = randomBytes(18).toString("base64url");
    await d1Query("INSERT INTO handoffs (token, from_tenant, from_label, to_tenant, transcript, need, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [token, from.tenantId, from.label.slice(0, 120), t.tenantId, turns, need.slice(0, 2000), now.toISOString(), expires]);
    out[t.tenantId] = token;
  }));
  // Expired rows go away as new ones are written (the conversation is not kept).
  d1Query("DELETE FROM handoffs WHERE expires_at < ?", [now.toISOString()]).catch(() => {});
  return out;
}

/** The hand-off behind a token, if it exists and has not expired. */
export async function getHandoff(token: string): Promise<Handoff | null> {
  if (!TOKEN_RE.test(token)) return null;
  await ensureSchema();
  const rows = await d1Query("SELECT * FROM handoffs WHERE token = ? AND expires_at > ?", [token, new Date().toISOString()]);
  const r = rows[0];
  if (!r) return null;
  let transcript: HandoffTurn[] = [];
  try { transcript = JSON.parse(r.transcript); } catch {}
  return { token, fromTenant: r.from_tenant, fromLabel: r.from_label || r.from_tenant, toTenant: r.to_tenant, transcript, need: r.need };
}

/** The customer opened the link (click-through). */
export async function markHandoffOpened(token: string): Promise<void> {
  await d1Query("UPDATE handoffs SET opens = COALESCE(opens, 0) + 1, opened_at = COALESCE(opened_at, ?) WHERE token = ?", [new Date().toISOString(), token]);
}
