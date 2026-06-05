/**
 * Authentication — now backed by Cloudflare D1 (sessions live in D1, validated
 * per-request so they're cross-instance-correct and survive Render restarts).
 *
 * Thin re-export of d1-auth.ts. NOTE: createSession / validateSession are now
 * ASYNC (return Promises) — callers must await them. Password hashing / API key
 * generation are unchanged (pure, no DB).
 */

export {
  hashPassword,
  verifyPassword,
  generateApiKey,
  createSession,
  validateSession,
} from "./d1-auth.js";
