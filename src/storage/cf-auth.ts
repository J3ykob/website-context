/**
 * Centralized Cloudflare API token. Source of truth is R2 (config/cf-token) so the
 * token can be rotated with a single file write — no Render dashboard edit or
 * redeploy needed. (The previous setup hardcoded a ~24h OAuth token in render.yaml /
 * Render env; when it expired, every Vectorize query + D1 call failed and only a
 * manual dashboard edit could fix it — the recurring "demos broke again" outage.)
 *
 * Serving (Render) calls loadCfToken() at startup. The VPS scraper has CF_API_TOKEN
 * in its .env, which is used as the fallback when R2 hasn't been loaded.
 */
import { downloadFromR2 } from "./r2.js";

let token = process.env.CF_API_TOKEN || "";

export function getCfToken(): string {
  return token;
}

export async function loadCfToken(): Promise<void> {
  try {
    const buf = await downloadFromR2("config/cf-token");
    const t = buf ? buf.toString().trim() : "";
    if (t) {
      token = t;
      console.log("[cf-auth] CF token loaded from R2 (config/cf-token)");
      return;
    }
    console.warn("[cf-auth] R2 config/cf-token empty/missing — falling back to env CF_API_TOKEN");
  } catch (e: any) {
    console.error(`[cf-auth] failed to load token from R2: ${e?.message} — falling back to env`);
  }
}

// Re-read from R2 (e.g. after a 401) so serving can recover from a rotated/expired
// token WITHOUT a Render restart — closing the recurring "demos broke again" outage.
// Debounced to at most once per 60s so a burst of 401s can't hammer R2.
let lastRefresh = 0;
export async function refreshCfToken(): Promise<void> {
  const now = Date.now();
  if (now - lastRefresh < 60000) return;
  lastRefresh = now;
  await loadCfToken();
}
