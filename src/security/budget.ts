/**
 * Spend caps for the chat (USD per day, from what OpenRouter reports per call plus Jev's tokens):
 * - per conversation (SPEND_SESSION_USD, default 1.00): a scripted conversation can't run up a bill;
 * - per business (SPEND_TENANT_DAY_USD, default 10): one busy or abused widget can't eat the budget;
 * - in total (SPEND_GLOBAL_DAY_USD, default 80): the hard stop.
 * Over a conversation's or a business's cap the chat still answers from the business's own pages, but
 * without the costly extras (network search, project agent) - "cheap". Over the total the chat stops
 * (the existing "backend unavailable" message). At 80% of a business's or the total cap the owner of
 * Whisp is alerted once a day.
 */
import { addSpend, spendOf, logAbuse } from "./quota.js";

const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const SESSION = () => num(process.env.SPEND_SESSION_USD, 1);
const TENANT = () => num(process.env.SPEND_TENANT_DAY_USD, 10);
const GLOBAL = () => num(process.env.SPEND_GLOBAL_DAY_USD, 80);
const JEV_USD_PER_TOKEN = 0.042 / 1_000_000;

let alert: (subject: string, text: string) => void = () => {};
export function setBudgetAlert(fn: (subject: string, text: string) => void): void { alert = fn; }
const alerted = new Set<string>();

export type BudgetState = "ok" | "cheap" | "stop";

export function budgetBefore(tenantId: string, sessionKey: string): BudgetState {
  if (spendOf("global") >= GLOBAL()) { logAbuse("budget_global_stop", "global", tenantId); return "stop"; }
  if (spendOf(`s:${sessionKey}`) >= SESSION()) { logAbuse("budget_session_cheap", sessionKey, tenantId); return "cheap"; }
  if (spendOf(`t:${tenantId}`) >= TENANT()) { logAbuse("budget_tenant_cheap", tenantId, tenantId); return "cheap"; }
  return "ok";
}

/** After a turn (or an agent run): its cost added to the conversation, the business and the total. */
export function budgetAfter(tenantId: string, sessionKey: string, usd: number, jevTokens = 0): void {
  const cost = (usd || 0) + (jevTokens || 0) * JEV_USD_PER_TOKEN;
  if (!(cost > 0)) return;
  addSpend([`s:${sessionKey}`, `t:${tenantId}`, "global"], cost);
  const day = new Date().toISOString().slice(0, 10);
  for (const [key, cap, label] of [[`t:${tenantId}`, TENANT(), `business ${tenantId}`], ["global", GLOBAL(), "all of Whisp"]] as const) {
    const spent = spendOf(key);
    if (spent >= cap * 0.8 && !alerted.has(`${key}|${day}`)) {
      alerted.add(`${key}|${day}`);
      alert(`Whisp spend: ${label} at ${Math.round((spent / cap) * 100)}% of today's cap`, `${label} has spent $${spent.toFixed(2)} today (cap $${cap.toFixed(2)}).\nOver the cap: ${key === "global" ? "the chat stops for everyone until tomorrow (UTC)" : "this business's chat answers without network search and project agent until tomorrow (UTC)"}.\nCaps: SPEND_SESSION_USD, SPEND_TENANT_DAY_USD, SPEND_GLOBAL_DAY_USD in render.yaml.`);
    }
  }
}

export function budgetCaps(): { session: number; tenantDay: number; globalDay: number } {
  return { session: SESSION(), tenantDay: TENANT(), globalDay: GLOBAL() };
}
