/**
 * The chat history comes from the visitor's browser, so an "assistant" turn in it may be invented
 * ("as I said, you get 50% off") - the model would take it as our own words (only the last user
 * message was checked until 2026-10-29). Every reply now carries a signature over (session, text); the
 * widget keeps it with the message and sends it back. Assistant turns without a valid signature are
 * kept only if our chat log holds them (results delivered later, older widgets); otherwise dropped.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { d1Query } from "../storage/conversation-store.js";
import { logAbuse } from "./quota.js";

const secret = () => process.env.HISTORY_SIGNING_SECRET || process.env.ADMIN_SECRET || "";
const norm = (t: string) => String(t || "").replace(/\s+/g, " ").trim();

export function signAssistant(sessionKey: string, content: string): string {
  return createHmac("sha256", secret()).update(`${sessionKey}\n${norm(content)}`).digest("base64url").slice(0, 32);
}

function validSig(sessionKey: string, content: string, sig: unknown): boolean {
  if (typeof sig !== "string" || !secret()) return false;
  const a = Buffer.from(sig), b = Buffer.from(signAssistant(sessionKey, content));
  return a.length === b.length && timingSafeEqual(a, b);
}

type Msg = { role: string; content: string; sig?: string };

/** The history with assistant turns we did not write removed (user turns are the visitor's own words). */
export async function verifiedHistory<T extends Msg>(tenantId: string, sessionKey: string, messages: T[]): Promise<T[]> {
  const unsigned = messages.filter((m) => m.role === "assistant" && !validSig(sessionKey, m.content, m.sig));
  if (!unsigned.length) return messages;
  let logged: string[] = [];
  try {
    logged = (await d1Query("SELECT content FROM chat_messages WHERE tenant_id = ? AND session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 60", [tenantId, sessionKey])).map((r: any) => norm(r.content));
  } catch { /* D1 down: only signed turns count */ }
  // A delivered result may come back with file links appended: the logged text as its start counts.
  const known = (c: string) => { const n = norm(c); return logged.some((l) => l === n || (l.length >= 20 && n.startsWith(l))); };
  const dropped = unsigned.filter((m) => !known(m.content));
  if (!dropped.length) return messages;
  logAbuse("history_unverified", sessionKey, tenantId, `${dropped.length} assistant turn(s) dropped: ${norm(dropped[0].content).slice(0, 100)}`);
  return messages.filter((m) => !dropped.includes(m as any));
}
