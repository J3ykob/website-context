/**
 * Channel Session Store — maintains conversation history for WhatsApp,
 * Messenger, and Instagram sessions.
 *
 * Each session is keyed by "{platform}_{senderId}" and stores the last N
 * messages. Sessions expire after a configurable TTL of inactivity.
 */

import type { ChatMessage } from "../llm/chat.js";

export interface ChannelSession {
  messages: ChatMessage[];
  lastActivity: number;
}

export interface SessionStoreConfig {
  /** Maximum messages to keep per session (default: 20) */
  maxMessages?: number;
  /** Session TTL in milliseconds (default: 30 minutes) */
  ttlMs?: number;
  /** Cleanup interval in milliseconds (default: 5 minutes) */
  cleanupIntervalMs?: number;
}

const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class ChannelSessionStore {
  private sessions = new Map<string, ChannelSession>();
  private maxMessages: number;
  private ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(config: SessionStoreConfig = {}) {
    this.maxMessages = config.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;

    const cleanupInterval = config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval);
  }

  /**
   * Build a session key from platform and sender ID.
   */
  static buildKey(platform: string, senderId: string): string {
    return `${platform}_${senderId}`;
  }

  /**
   * Get the current conversation messages for a session.
   * Returns an empty array if the session doesn't exist or has expired.
   */
  getMessages(sessionKey: string): ChatMessage[] {
    const session = this.sessions.get(sessionKey);
    if (!session) return [];

    // Check if expired
    if (Date.now() - session.lastActivity > this.ttlMs) {
      this.sessions.delete(sessionKey);
      return [];
    }

    return [...session.messages];
  }

  /**
   * Add a user message to the session and return the updated message history.
   * Creates the session if it doesn't exist.
   */
  addUserMessage(sessionKey: string, text: string): ChatMessage[] {
    const session = this.getOrCreateSession(sessionKey);
    session.messages.push({ role: "user", content: text });
    this.trimMessages(session);
    session.lastActivity = Date.now();
    return [...session.messages];
  }

  /**
   * Add an assistant message to the session.
   */
  addAssistantMessage(sessionKey: string, text: string): void {
    const session = this.getOrCreateSession(sessionKey);
    session.messages.push({ role: "assistant", content: text });
    this.trimMessages(session);
    session.lastActivity = Date.now();
  }

  /**
   * Clear a specific session.
   */
  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  /**
   * Get the number of active sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Stop the cleanup timer (for clean shutdown).
   */
  destroy(): void {
    clearInterval(this.cleanupTimer);
  }

  // ─── Private helpers ───────────────────────────────────────────────────

  private getOrCreateSession(sessionKey: string): ChannelSession {
    let session = this.sessions.get(sessionKey);

    if (!session || Date.now() - session.lastActivity > this.ttlMs) {
      // Create new session (or reset expired one)
      session = { messages: [], lastActivity: Date.now() };
      this.sessions.set(sessionKey, session);
    }

    return session;
  }

  private trimMessages(session: ChannelSession): void {
    if (session.messages.length > this.maxMessages) {
      // Keep the most recent messages, dropping from the front
      session.messages = session.messages.slice(-this.maxMessages);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, session] of this.sessions) {
      if (now - session.lastActivity > this.ttlMs) {
        this.sessions.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[channel-sessions] Cleaned up ${cleaned} expired sessions (${this.sessions.size} active)`);
    }
  }
}
