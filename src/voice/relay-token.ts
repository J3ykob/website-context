/**
 * The voice relay's key: minted in the Twilio-signed TwiML (/api/voice/relay-twiml), checked when the
 * WebSocket's setup arrives. It carries the number we dialed, so the demo SMS goes only to a real
 * callee - without it anyone could open the WebSocket, name any number and have us text it (SMS
 * pumping) or use the bot's LLM for free (open until 2026-10-29).
 */
import { createHmac, timingSafeEqual } from "crypto";

const secret = () => process.env.TWILIO_AUTH_TOKEN || process.env.ADMIN_SECRET || "";
const sign = (payload: string) => createHmac("sha256", secret()).update(`relay:${payload}`).digest("base64url");

export function mintRelayToken(prospect: string, ttlMs = 10 * 60_000): string {
  const payload = Buffer.from(JSON.stringify({ p: prospect, exp: Date.now() + ttlMs })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The dialed number when the token is genuine and fresh (it may be ""), null otherwise. */
export function verifyRelayToken(token: string): string | null {
  if (!secret()) return null;
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof d.exp === "number" && d.exp > Date.now() ? String(d.p || "") : null;
  } catch { return null; }
}
