/**
 * Channel integrations — barrel export.
 *
 * Provides adapters for external messaging platforms (WhatsApp, Messenger,
 * Instagram) and shared session management for channel conversations.
 */

export {
  detectPlatform,
  extractMessage,
  sendReply,
  verifyWebhook,
  formatForWhatsApp,
  formatForMessenger,
  getVerifyToken,
  validateConfig,
} from "./meta.js";

export type {
  MetaChannelConfig,
  MetaPlatform,
  ExtractedMessage,
} from "./meta.js";

export { ChannelSessionStore } from "./session-store.js";

export type { ChannelSession, SessionStoreConfig } from "./session-store.js";
