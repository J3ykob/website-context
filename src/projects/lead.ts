/**
 * A customer's request offered to a business that has not joined the network (the link in its invite).
 * Before paying it sees part of the request; the rest stays on the server (the page shows filler, blurred).
 * The request is reserved for it for LEAD_EXCLUSIVE_HOURS (the timer is that real window): unpaid when it
 * ends, the request goes to the next business picked for that part. Paying = the network subscription
 * (Stripe Checkout, checked with Stripe on the way back): the business sees the whole request and the
 * answer prepared from its price list, and sends its own offer - it reaches the customer through Whisp
 * (no customer contact data is shared). A subscribed business gets its later requests unlocked.
 */
import { getProject, setMemory, addEvent } from "./store.js";
import { readFile } from "./repo.js";
import { d1Query } from "../storage/conversation-store.js";
import { getTenant, updateTenant } from "../multi-tenant/d1-registry.js";

const EXCLUSIVE_MS = () => (Number(process.env.LEAD_EXCLUSIVE_HOURS) || 24) * 3600_000;
const PRICE_PLN = () => Number(process.env.NETWORK_PLAN_PRICE_PLN) || 149;
const STRIPE = "https://api.stripe.com/v1";

let ready: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  ready ||= (async () => {
    await d1Query("CREATE TABLE IF NOT EXISTS network_invites (tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, token TEXT NOT NULL, emailed INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, project_id))");
    for (const col of ["unlocked_at TEXT", "passed_at TEXT", "replied_at TEXT"]) await d1Query(`ALTER TABLE network_invites ADD COLUMN ${col}`).catch(() => {}); // exists already
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

interface Invite { tenant_id: string; project_id: string; token: string; created_at: string; unlocked_at: string | null; passed_at: string | null; replied_at: string | null }

async function inviteByToken(token: string): Promise<Invite | null> {
  await ensureSchema();
  return ((await d1Query("SELECT * FROM network_invites WHERE token = ?", [token]))[0] as Invite) || null;
}

const stripeKey = () => (process.env.STRIPE_SECRET_KEY || "").trim();
async function stripe(path: string, init?: { method?: string; form?: Record<string, string> }): Promise<any> {
  const r = await fetch(`${STRIPE}${path}`, {
    method: init?.method || "GET",
    headers: { Authorization: `Bearer ${stripeKey()}`, ...(init?.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: init?.form ? new URLSearchParams(init.form).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`stripe ${r.status}: ${j?.error?.message || "error"}`);
  return j;
}

// Subscription status per business, checked with Stripe at most every 10 minutes.
const subCache = new Map<string, { active: boolean; at: number }>();
export async function subscribed(tenantId: string): Promise<boolean> {
  const id = getTenant(tenantId)?.settings?.stripeSubscription as string | undefined;
  if (!id || !stripeKey()) return false;
  const hit = subCache.get(tenantId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.active;
  const s = await stripe(`/subscriptions/${encodeURIComponent(id)}`).catch(() => null);
  const active = !!s && ["active", "trialing"].includes(String(s.status));
  subCache.set(tenantId, { active, at: Date.now() });
  return active;
}

export interface LeadView {
  status: "open" | "unlocked" | "replied" | "passed";
  business: string; from: string; brand: string;
  teaser: string;          // the visible part of the request
  hiddenChars: number;     // how much is hidden (the page draws that much blurred filler)
  request?: string; answer?: string; // only when unlocked
  expiresAt: string; pricePln: number; payments: boolean; phone: string;
}

/** The part of a request shown before paying: its first sentence or so - enough to see what it is. */
function teaserOf(text: string): string {
  const t = text.trim();
  const cut = Math.max(60, Math.floor(t.length * 0.35));
  if (t.length <= cut) return t.slice(0, Math.ceil(t.length / 2));
  const space = t.lastIndexOf(" ", cut);
  return t.slice(0, space > 40 ? space : cut);
}

export async function leadView(token: string): Promise<LeadView | null> {
  const inv = await inviteByToken(token);
  if (!inv) return null;
  const sub = await getProject(inv.project_id);
  if (!sub) return null;
  const { businessLabel } = await import("./network.js");
  const question = String(sub.memory.question || "") || ((await readFile(sub.id, "request.txt").catch(() => null)) || "");
  const unlocked = !!inv.unlocked_at || (await subscribed(inv.tenant_id));
  if (unlocked && !inv.unlocked_at) await d1Query("UPDATE network_invites SET unlocked_at = ? WHERE token = ? AND unlocked_at IS NULL", [new Date().toISOString(), token]);
  const expires = Date.parse(inv.created_at) + EXCLUSIVE_MS();
  const status: LeadView["status"] = inv.replied_at ? "replied" : unlocked ? "unlocked" : inv.passed_at || Date.now() > expires ? "passed" : "open";
  const teaser = teaserOf(question);
  return {
    status, business: businessLabel(inv.tenant_id), from: businessLabel(String(sub.memory.fromTenant || "")), brand: "Whisp",
    teaser, hiddenChars: Math.max(0, question.length - teaser.length),
    ...(unlocked ? { request: question, answer: ((await readFile(sub.id, "odpowiedz.txt").catch(() => null)) || "").trim() } : {}),
    expiresAt: new Date(expires).toISOString(), pricePln: PRICE_PLN(), payments: !!stripeKey(),
    phone: (process.env.NETWORK_INVITE_PHONE || "").trim(),
  };
}

/** Stripe Checkout for the network subscription; back to the lead page, where the payment is checked. */
export async function startCheckout(token: string, base: string): Promise<string> {
  const inv = await inviteByToken(token);
  if (!inv) throw new Error("not found");
  if (!stripeKey()) throw new Error("payments are not set up");
  const { businessLabel } = await import("./network.js");
  const back = `${base}/lead/${encodeURIComponent(token)}`;
  const s = await stripe("/checkout/sessions", { method: "POST", form: {
    mode: "subscription", locale: "pl",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "pln",
    "line_items[0][price_data][unit_amount]": String(Math.round(PRICE_PLN() * 100)),
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][product_data][name]": "Whisp - zapytania klientów z sieci firm",
    success_url: `${back}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: back,
    client_reference_id: inv.tenant_id,
    "metadata[token]": token, "metadata[tenantId]": inv.tenant_id,
    "subscription_data[metadata][tenantId]": inv.tenant_id,
    "subscription_data[description]": `Whisp: ${businessLabel(inv.tenant_id)}`,
  } });
  return String(s.url);
}

/** Back from Stripe: the session is checked with Stripe itself; paid -> the business is a member, unlocked. */
export async function confirmCheckout(token: string, sessionId: string): Promise<boolean> {
  const inv = await inviteByToken(token);
  if (!inv || !stripeKey() || !sessionId) return false;
  const s = await stripe(`/checkout/sessions/${encodeURIComponent(sessionId)}`).catch(() => null);
  if (!s || s.metadata?.token !== token || s.status !== "complete" || !["paid", "no_payment_required"].includes(String(s.payment_status))) return false;
  const t = getTenant(inv.tenant_id);
  if (t) {
    const settings = { ...(t.settings || {}), stripeCustomer: String(s.customer || ""), stripeSubscription: String(s.subscription || "") };
    delete settings.network; // a member now: its requests come to it first, answered under its own settings
    updateTenant(t.id, { settings });
  }
  subCache.delete(inv.tenant_id);
  await d1Query("UPDATE network_invites SET unlocked_at = COALESCE(unlocked_at, ?) WHERE token = ?", [new Date().toISOString(), token]);
  await addEvent(inv.project_id, { kind: "lead_unlocked", actor: inv.tenant_id, data: { session: sessionId, subscription: s.subscription || null } });
  return true;
}

/**
 * The business's own offer for the request: back into the customer's project (the business running it
 * sees it; the customer gets it on their page and in the chat).
 */
export async function replyToLead(token: string, offer: string): Promise<boolean> {
  const v = await leadView(token);
  const inv = await inviteByToken(token);
  if (!v || !inv || (v.status !== "unlocked" && v.status !== "replied")) return false;
  const sub = await getProject(inv.project_id);
  const parentId = sub?.memory.parentId as string | undefined;
  if (!sub || !parentId) return false;
  const { settle, businessLabel } = await import("./network.js");
  // Recorded as the business's own answer after the customer's result: never a new round (no re-run of
  // the customer's project, no new invite) - so the request counts as settled first.
  if (!sub.memory.settled) await setMemory(sub.id, { settled: "answered" });
  await settle(sub.id, offer, "answered");
  const parent = await getProject(parentId);
  if (parent) {
    const offers = [...((parent.memory.businessOffers as any[]) || []), { tenantId: inv.tenant_id, label: businessLabel(inv.tenant_id), text: offer.slice(0, 4000), at: new Date().toISOString() }];
    await setMemory(parentId, { businessOffers: offers });
    const { logMessage } = await import("../storage/conversation-store.js");
    await logMessage(parent.initiatorTenantId, parent.customerSession, "assistant", `Oferta od firmy ${businessLabel(inv.tenant_id)}:\n\n${offer.slice(0, 4000)}`, { flowInvoked: "network-offer" }).catch(() => {});
  }
  await d1Query("UPDATE network_invites SET replied_at = ? WHERE token = ?", [new Date().toISOString(), token]);
  return true;
}

/**
 * Requests whose reservation ended unpaid go to the next business picked for the same part (once each).
 * Run periodically by the server.
 */
export async function passExpiredLeads(): Promise<number> {
  await ensureSchema();
  const cutoff = new Date(Date.now() - EXCLUSIVE_MS()).toISOString();
  const due = (await d1Query("SELECT * FROM network_invites WHERE unlocked_at IS NULL AND passed_at IS NULL AND created_at < ? LIMIT 20", [cutoff])) as Invite[];
  let passed = 0;
  for (const inv of due) {
    const claimed = await d1Query("UPDATE network_invites SET passed_at = ? WHERE token = ? AND passed_at IS NULL RETURNING token", [new Date().toISOString(), inv.token]);
    if (!claimed.length || (await subscribed(inv.tenant_id))) continue;
    const sub = await getProject(inv.project_id);
    const parentId = sub?.memory.parentId as string | undefined;
    const parent = parentId ? await getProject(parentId) : null;
    if (!sub || !parent) continue;
    // The next pick for the same part, not asked yet.
    const b = parent.memory.broadcast as { picked: { tenantId: string; part: number }[] } | undefined;
    const asked = new Set(((parent.memory.subRequests as any[]) || []).map((x) => x.tenantId));
    const parts = new Set((b?.picked || []).filter((o) => o.tenantId === inv.tenant_id).map((o) => o.part));
    const next = (b?.picked || []).find((o) => parts.has(o.part) && !asked.has(o.tenantId) && o.tenantId !== parent.initiatorTenantId);
    await addEvent(parent.id, { kind: "lead_passed", actor: "system", data: { from: inv.tenant_id, to: next?.tenantId || null } });
    if (!next) continue;
    const { askOne } = await import("./network.js");
    const s2 = await askOne(parent.id, next.tenantId, String(sub.memory.question || "")).catch(() => null);
    if (s2) { await setMemory(parent.id, { subRequests: [...((parent.memory.subRequests as any[]) || []), s2] }); passed++; }
  }
  return passed;
}
