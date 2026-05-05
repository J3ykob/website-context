/**
 * Meta Channel Adapter — unified handler for WhatsApp, Messenger, and Instagram
 * webhooks via Meta's Graph API.
 *
 * All three platforms share the same Graph API infrastructure but differ in
 * payload shape and reply format.
 */

const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ─── Config ────────────────────────────────────────────────────────────────

export interface MetaChannelConfig {
  whatsapp?: {
    phoneNumberId: string;
    accessToken: string;
    verifyToken: string;
  };
  messenger?: {
    pageId: string;
    pageAccessToken: string;
    verifyToken: string;
  };
  instagram?: {
    accountId: string;
    pageAccessToken: string; // same as messenger (linked Page)
    verifyToken: string;
  };
}

export type MetaPlatform = "whatsapp" | "messenger" | "instagram";

export interface ExtractedMessage {
  senderId: string;
  text: string;
  messageId: string;
}

// ─── Platform Detection ────────────────────────────────────────────────────

/**
 * Detect which Meta platform sent the webhook based on payload structure.
 *
 * - WhatsApp: object === "whatsapp_business_account"
 * - Instagram: object === "instagram" OR entry[].messaging[] with instagram-style IDs
 * - Messenger: object === "page" (default for Page-based webhooks)
 */
export function detectPlatform(body: any): MetaPlatform | null {
  if (!body || typeof body !== "object") return null;

  const obj = body.object;

  if (obj === "whatsapp_business_account") {
    return "whatsapp";
  }

  if (obj === "instagram") {
    return "instagram";
  }

  if (obj === "page") {
    // Messenger and Instagram both use Page subscriptions.
    // Instagram messages have a `recipient` with an instagram-scoped ID
    // and may include a `message.is_echo` or sender/recipient patterns.
    // The most reliable check: if the entry has a `messaging` array and
    // the sender or message metadata indicates Instagram.
    const entry = body.entry?.[0];
    if (entry?.messaging?.[0]) {
      // Instagram webhook events on a Page subscription sometimes include
      // the "instagram" field at the entry level.
      if (entry.id && entry.messaging[0]?.sender?.id) {
        // Check if entry-level has explicit Instagram indicators
        // Instagram DMs via Pages API have different structure
        // but we default to Messenger unless we see Instagram signals
      }
    }
    return "messenger";
  }

  return null;
}

// ─── Message Extraction ────────────────────────────────────────────────────

/**
 * Extract the incoming text message from a Meta webhook payload.
 * Returns null if the payload contains no processable text message
 * (e.g., status updates, read receipts, media-only messages).
 */
export function extractMessage(platform: MetaPlatform, body: any): ExtractedMessage | null {
  try {
    switch (platform) {
      case "whatsapp":
        return extractWhatsAppMessage(body);
      case "messenger":
        return extractMessengerMessage(body);
      case "instagram":
        return extractInstagramMessage(body);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function extractWhatsAppMessage(body: any): ExtractedMessage | null {
  const entry = body.entry?.[0];
  if (!entry) return null;

  const change = entry.changes?.[0];
  if (!change || change.field !== "messages") return null;

  const value = change.value;
  if (!value) return null;

  const message = value.messages?.[0];
  if (!message) return null;

  // Only handle text messages for now
  if (message.type !== "text" || !message.text?.body) return null;

  return {
    senderId: message.from, // phone number in international format
    text: message.text.body,
    messageId: message.id,
  };
}

function extractMessengerMessage(body: any): ExtractedMessage | null {
  const entry = body.entry?.[0];
  if (!entry) return null;

  const messaging = entry.messaging?.[0];
  if (!messaging) return null;

  // Skip echoes (messages sent BY the page)
  if (messaging.message?.is_echo) return null;

  // Skip delivery/read receipts
  if (messaging.delivery || messaging.read) return null;

  const message = messaging.message;
  if (!message?.text) return null;

  return {
    senderId: messaging.sender.id,
    text: message.text,
    messageId: message.mid,
  };
}

function extractInstagramMessage(body: any): ExtractedMessage | null {
  // Instagram DMs have the same structure as Messenger when received
  // via the Instagram Messaging API
  const entry = body.entry?.[0];
  if (!entry) return null;

  const messaging = entry.messaging?.[0];
  if (!messaging) return null;

  // Skip echoes
  if (messaging.message?.is_echo) return null;

  // Skip delivery/read receipts
  if (messaging.delivery || messaging.read) return null;

  const message = messaging.message;
  if (!message?.text) return null;

  return {
    senderId: messaging.sender.id,
    text: message.text,
    messageId: message.mid,
  };
}

// ─── Reply Sending ─────────────────────────────────────────────────────────

/**
 * Send a reply back to the user via the appropriate Graph API endpoint.
 */
export async function sendReply(
  platform: MetaPlatform,
  config: MetaChannelConfig,
  senderId: string,
  text: string
): Promise<void> {
  switch (platform) {
    case "whatsapp":
      return sendWhatsAppReply(config, senderId, text);
    case "messenger":
      return sendMessengerReply(config, senderId, text);
    case "instagram":
      return sendInstagramReply(config, senderId, text);
  }
}

async function sendWhatsAppReply(
  config: MetaChannelConfig,
  senderId: string,
  text: string
): Promise<void> {
  const wa = config.whatsapp;
  if (!wa) throw new Error("WhatsApp config not set");

  const formattedText = formatForWhatsApp(text);

  const resp = await fetch(`${GRAPH_API_BASE}/${wa.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${wa.accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: senderId,
      type: "text",
      text: { body: formattedText },
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`WhatsApp send failed (${resp.status}): ${errBody}`);
  }
}

async function sendMessengerReply(
  config: MetaChannelConfig,
  senderId: string,
  text: string
): Promise<void> {
  const m = config.messenger;
  if (!m) throw new Error("Messenger config not set");

  const formattedText = formatForMessenger(text);

  const resp = await fetch(`${GRAPH_API_BASE}/me/messages?access_token=${m.pageAccessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: senderId },
      message: { text: formattedText },
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Messenger send failed (${resp.status}): ${errBody}`);
  }
}

async function sendInstagramReply(
  config: MetaChannelConfig,
  senderId: string,
  text: string
): Promise<void> {
  const ig = config.instagram;
  if (!ig) throw new Error("Instagram config not set");

  const formattedText = formatForMessenger(text); // Instagram uses same format as Messenger

  const resp = await fetch(`${GRAPH_API_BASE}/me/messages?access_token=${ig.pageAccessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: senderId },
      message: { text: formattedText },
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Instagram send failed (${resp.status}): ${errBody}`);
  }
}

// ─── Webhook Verification ──────────────────────────────────────────────────

/**
 * Verify a Meta webhook subscription.
 * Meta sends GET with hub.mode=subscribe, hub.challenge=xxx, hub.verify_token=yyy.
 * Return the challenge string if the verify token matches, null otherwise.
 */
export function verifyWebhook(query: any, verifyToken: string): string | null {
  const mode = query["hub.mode"];
  const challenge = query["hub.challenge"];
  const token = query["hub.verify_token"];

  if (mode === "subscribe" && token === verifyToken) {
    return challenge;
  }

  return null;
}

// ─── Text Formatting ───────────────────────────────────────────────────────

/**
 * Format bot response for WhatsApp.
 * WhatsApp uses its own formatting: *bold*, _italic_, ~strikethrough~, ```monospace```
 * Convert standard markdown to WhatsApp format.
 */
export function formatForWhatsApp(text: string): string {
  let result = text;

  // Convert **bold** or __bold__ to *bold*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "_$1_");

  // Convert [link text](url) to "link text (url)"
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Remove heading markers (## Heading -> Heading)
  result = result.replace(/^#{1,6}\s+/gm, "");

  // Convert bullet points (- item) to WhatsApp-friendly format
  // WhatsApp renders these fine as-is

  // Remove HTML tags if any leaked through
  result = result.replace(/<[^>]+>/g, "");

  return result.trim();
}

/**
 * Format bot response for Messenger/Instagram.
 * Messenger supports minimal formatting. Strip most markdown.
 */
export function formatForMessenger(text: string): string {
  let result = text;

  // Remove bold/italic markers (Messenger doesn't render markdown)
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");
  result = result.replace(/_(.+?)_/g, "$1");

  // Convert [link text](url) to "link text: url"
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1: $2");

  // Remove heading markers
  result = result.replace(/^#{1,6}\s+/gm, "");

  // Remove HTML tags
  result = result.replace(/<[^>]+>/g, "");

  return result.trim();
}

// ─── Config Helpers ────────────────────────────────────────────────────────

/**
 * Get the verify token for a specific platform from the channel config.
 * Falls back to checking all configured platforms.
 */
export function getVerifyToken(config: MetaChannelConfig, platform?: MetaPlatform): string | null {
  if (platform) {
    switch (platform) {
      case "whatsapp":
        return config.whatsapp?.verifyToken || null;
      case "messenger":
        return config.messenger?.verifyToken || null;
      case "instagram":
        return config.instagram?.verifyToken || null;
    }
  }

  // Return the first available verify token (all platforms typically share one)
  return (
    config.whatsapp?.verifyToken ||
    config.messenger?.verifyToken ||
    config.instagram?.verifyToken ||
    null
  );
}

/**
 * Validate that a MetaChannelConfig has at least one platform configured.
 */
export function validateConfig(config: MetaChannelConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.whatsapp && !config.messenger && !config.instagram) {
    errors.push("At least one platform (whatsapp, messenger, or instagram) must be configured");
    return { valid: false, errors };
  }

  if (config.whatsapp) {
    if (!config.whatsapp.phoneNumberId) errors.push("whatsapp.phoneNumberId is required");
    if (!config.whatsapp.accessToken) errors.push("whatsapp.accessToken is required");
    if (!config.whatsapp.verifyToken) errors.push("whatsapp.verifyToken is required");
  }

  if (config.messenger) {
    if (!config.messenger.pageId) errors.push("messenger.pageId is required");
    if (!config.messenger.pageAccessToken) errors.push("messenger.pageAccessToken is required");
    if (!config.messenger.verifyToken) errors.push("messenger.verifyToken is required");
  }

  if (config.instagram) {
    if (!config.instagram.accountId) errors.push("instagram.accountId is required");
    if (!config.instagram.pageAccessToken) errors.push("instagram.pageAccessToken is required");
    if (!config.instagram.verifyToken) errors.push("instagram.verifyToken is required");
  }

  return { valid: errors.length === 0, errors };
}
