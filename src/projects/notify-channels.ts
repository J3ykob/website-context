/**
 * How a customer can be told that their request's result is ready, besides e-mail: SMS and WhatsApp
 * (Twilio), Telegram (a bot the customer starts from the status page). A channel is offered only when
 * its credentials are set; a message is sent only once its text is approved (CUSTOMER_UPDATES_APPROVED=1,
 * the owner's rule for new outgoing texts) - until then nothing goes out and the event says why.
 * Texts: templates/messages/result-ready.<lang>.txt ({{brand}}, {{link}}).
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export type Channel = "email" | "sms" | "whatsapp" | "telegram";

export function availableChannels(): Channel[] {
  const out: Channel[] = ["email"];
  // Offered only once their texts are approved: a channel the customer picks must really send.
  if (process.env.CUSTOMER_UPDATES_APPROVED !== "1") return out;
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) out.push("sms");
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM && process.env.TWILIO_WHATSAPP_TEMPLATE_SID) out.push("whatsapp");
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME) out.push("telegram");
  return out;
}

/** The Telegram deep link that connects this request's updates to the customer's Telegram. */
export const telegramLink = (token: string): string | null =>
  process.env.TELEGRAM_BOT_USERNAME ? `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(token)}` : null;

/** A phone number as E.164 (Polish numbers without a prefix get +48); null if it isn't one. */
export function normalizePhone(raw: string): string | null {
  let d = String(raw || "").replace(/[\s().-]/g, "");
  if (d.startsWith("00")) d = `+${d.slice(2)}`;
  if (/^\d{9}$/.test(d)) d = `+48${d}`;
  return /^\+\d{8,15}$/.test(d) ? d : null;
}

function message(lang: string, vars: Record<string, string>, name = "result-ready"): string | null {
  const dir = resolve("templates/messages");
  const file = [`${name}.${lang}.txt`, `${name}.pl.txt`].map((f) => resolve(dir, f)).find((f) => existsSync(f));
  if (!file) return null;
  const text = readFileSync(file, "utf-8").split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();
  return Object.entries(vars).reduce((t, [k, v]) => t.split(`{{${k}}}`).join(v), text);
}

async function twilio(to: string, from: string, body: string, template?: { sid: string; vars: Record<string, string> }): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID!, auth = process.env.TWILIO_AUTH_TOKEN!;
  // WhatsApp messages we start must use a Meta-approved template (ContentSid); free text only inside a 24 h reply window.
  const params: Record<string, string> = template ? { To: to, From: from, ContentSid: template.sid, ContentVariables: JSON.stringify(template.vars) } : { To: to, From: from, Body: body };
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  return !!r && r.ok;
}

export async function telegramSend(chatId: string | number, text: string): Promise<boolean> {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }), signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  return !!r && r.ok;
}

export interface CustomerContact { email?: string; phone?: string; whatsapp?: string; telegramChatId?: string; lang: string; at: string }

/** "Your result is ready" on every non-email channel the customer chose. Returns what was sent (or why not). */
export function sendResultReady(contact: CustomerContact, vars: { brand: string; link: string }): Promise<Record<string, string>> {
  return sendUpdate(contact, "result-ready", vars, process.env.CUSTOMER_UPDATES_APPROVED === "1");
}

/** "A business sent an offer" (templates/messages/new-offer.<lang>.txt; its own approval: CUSTOMER_OFFER_UPDATES_APPROVED=1). */
export function sendNewOffer(contact: CustomerContact, vars: { brand: string; business: string; link: string }): Promise<Record<string, string>> {
  // Our number for "call us" (calls to it forward to Whisp - /api/voice/incoming).
  const phone = process.env.CUSTOMER_UPDATES_PHONE || process.env.NETWORK_INVITE_PHONE || "+48 729 086 795";
  return sendUpdate(contact, "new-offer", { ...vars, phone }, process.env.CUSTOMER_UPDATES_APPROVED === "1" && process.env.CUSTOMER_OFFER_UPDATES_APPROVED === "1");
}

async function sendUpdate(contact: CustomerContact, name: string, vars: Record<string, string>, approved: boolean): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const chosen = (["sms", "whatsapp", "telegram"] as const).filter((c) => (c === "sms" ? contact.phone : c === "whatsapp" ? contact.whatsapp : contact.telegramChatId));
  if (!chosen.length) return out;
  const text = message(contact.lang, vars, name);
  const { bump, logAbuse } = await import("../security/quota.js");
  for (const c of chosen) {
    if (!approved) { out[c] = "not sent: message text not approved yet"; continue; }
    if (!text) { out[c] = "not sent: no template"; continue; }
    // Per recipient per day (anyone can start requests and give someone else's number): MSG_PER_DAY_SMS 3,
    // MSG_PER_DAY_WHATSAPP 5, MSG_PER_DAY_TELEGRAM 10.
    const dest = c === "sms" ? contact.phone! : c === "whatsapp" ? contact.whatsapp! : contact.telegramChatId!;
    const cap = Number(process.env[`MSG_PER_DAY_${c.toUpperCase()}`]) || (c === "sms" ? 3 : c === "whatsapp" ? 5 : 10);
    const exempt = (process.env.MSG_CAP_EXEMPT || "").split(",").map((x) => x.trim()).filter(Boolean).includes(dest);
    if (!exempt && !(await bump(`msg:${c}:${dest}`, cap))) { out[c] = "not sent: daily limit for this recipient"; logAbuse("message_cap", `${c}:${dest}`); continue; }
    const ok = c === "sms" ? await twilio(contact.phone!, process.env.TWILIO_FROM_NUMBER!, text)
      : c === "whatsapp" ? await twilio(`whatsapp:${contact.whatsapp}`, `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`, text, name === "result-ready" && process.env.TWILIO_WHATSAPP_TEMPLATE_SID ? { sid: process.env.TWILIO_WHATSAPP_TEMPLATE_SID, vars: { "1": vars.brand, "2": vars.link } } : undefined)
      : await telegramSend(contact.telegramChatId!, text);
    out[c] = ok ? "sent" : "failed";
  }
  return out;
}
