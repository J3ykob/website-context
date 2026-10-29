/**
 * Daily quotas, spend and the abuse log - shared by every instance and kept across deploys (D1).
 *
 * - bump(key, limit): counts one use of `key` today and says whether it is still within `limit`
 *   (project agent runs per session / IP / business, messages per recipient, ...).
 * - addSpend / spendOf: what the chat cost today (USD) per session, per business and in total; the
 *   chat checks it before a turn (src/security/budget.ts). Kept in memory, written to D1 every 30 s
 *   and loaded back on start.
 * - logAbuse: a limit hit, a blocked injection, a budget stop - for the spike alert and the daily
 *   summary (scripts/serve-multi-tenant.ts).
 *
 * D1 unavailable: quotas allow (a chat never breaks on it) and count in memory for this instance.
 */
import { d1Query } from "../storage/conversation-store.js";

const day = () => new Date().toISOString().slice(0, 10);

let ready: Promise<void> | null = null;
function schema(): Promise<void> {
  ready ||= (async () => {
    await d1Query("CREATE TABLE IF NOT EXISTS usage_quota (key TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (key, day))");
    await d1Query("CREATE TABLE IF NOT EXISTS spend_daily (key TEXT NOT NULL, day TEXT NOT NULL, usd REAL NOT NULL, PRIMARY KEY (key, day))");
    await d1Query("CREATE TABLE IF NOT EXISTS abuse_events (at TEXT NOT NULL, kind TEXT NOT NULL, key TEXT, tenant_id TEXT, detail TEXT)");
    await d1Query("CREATE INDEX IF NOT EXISTS abuse_events_at ON abuse_events (at)");
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

const local = new Map<string, number>();
/** One use of `key` today; true while the count is within `limit`. */
export async function bump(key: string, limit: number): Promise<boolean> {
  const d = day();
  try {
    await schema();
    const r = await d1Query("INSERT INTO usage_quota (key, day, n) VALUES (?, ?, 1) ON CONFLICT (key, day) DO UPDATE SET n = n + 1 RETURNING n", [key, d]);
    return Number(r[0]?.n || 1) <= limit;
  } catch {
    const k = `${key}|${d}`;
    const n = (local.get(k) || 0) + 1;
    if (local.size > 50_000) local.clear();
    local.set(k, n);
    return n <= limit;
  }
}

/** Today's count for `key` without adding to it. */
export async function peek(key: string): Promise<number> {
  try { await schema(); return Number((await d1Query("SELECT n FROM usage_quota WHERE key = ? AND day = ?", [key, day()]))[0]?.n || 0); }
  catch { return local.get(`${key}|${day()}`) || 0; }
}

// ── Spend ──
const spend = new Map<string, number>(); // "key|day" -> usd
const unsaved = new Map<string, number>();
let loadedDay = "";
async function loadToday(): Promise<void> {
  const d = day();
  if (loadedDay === d) return;
  loadedDay = d;
  try {
    await schema();
    for (const r of await d1Query("SELECT key, usd FROM spend_daily WHERE day = ?", [d])) spend.set(`${r.key}|${d}`, Math.max(spend.get(`${r.key}|${d}`) || 0, Number(r.usd) || 0));
  } catch { loadedDay = ""; }
}
void loadToday();

export function addSpend(keys: string[], usd: number): void {
  if (!(usd > 0)) return;
  const d = day();
  for (const key of keys) {
    const k = `${key}|${d}`;
    spend.set(k, (spend.get(k) || 0) + usd);
    unsaved.set(k, (unsaved.get(k) || 0) + usd);
  }
}
export function spendOf(key: string): number {
  void loadToday();
  return spend.get(`${key}|${day()}`) || 0;
}
async function flushSpend(): Promise<void> {
  if (!unsaved.size) return;
  const batch = [...unsaved.entries()];
  unsaved.clear();
  try {
    await schema();
    for (const [k, usd] of batch) {
      const [key, d] = k.split("|");
      await d1Query("INSERT INTO spend_daily (key, day, usd) VALUES (?, ?, ?) ON CONFLICT (key, day) DO UPDATE SET usd = usd + excluded.usd", [key, d, usd]);
    }
  } catch { for (const [k, usd] of batch) unsaved.set(k, (unsaved.get(k) || 0) + usd); }
  // Yesterday's entries are no longer needed in memory.
  const d = day();
  for (const k of spend.keys()) if (!k.endsWith(`|${d}`)) spend.delete(k);
}
setInterval(() => { void flushSpend(); }, 30_000).unref();

// ── Abuse log ──
export function logAbuse(kind: string, key: string, tenantId = "", detail = ""): void {
  console.warn(`[abuse] ${kind} ${key}${tenantId ? ` tenant=${tenantId}` : ""}${detail ? ` ${detail.slice(0, 120)}` : ""}`);
  void schema().then(() => d1Query("INSERT INTO abuse_events (at, kind, key, tenant_id, detail) VALUES (?, ?, ?, ?, ?)", [new Date().toISOString(), kind, key.slice(0, 200), tenantId, detail.slice(0, 500)])).catch(() => {});
}

/** Abuse events since `sinceIso`, grouped by kind (for the spike alert and the daily summary). */
export async function abuseSummary(sinceIso: string): Promise<{ kind: string; n: number; keys: number; tenants: string }[]> {
  await schema();
  return (await d1Query("SELECT kind, COUNT(*) AS n, COUNT(DISTINCT key) AS keys, GROUP_CONCAT(DISTINCT tenant_id) AS tenants FROM abuse_events WHERE at > ? GROUP BY kind ORDER BY n DESC", [sinceIso])) as any;
}
