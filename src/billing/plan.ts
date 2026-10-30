/**
 * The Whisp plan (the owner's decision 2026-10-30): the chat widget is free for every business; the panel
 * - conversations, analytics, knowledge and offer editing, settings, requests from the network - is paid
 * from day one: 149 zł a month including VAT (STRIPE_PRICE_ID), no card needed to sign up. One plan for
 * businesses that sign up and for those that join from a network request (projects/lead.ts).
 * The subscription is checked with Stripe itself (cached 10 minutes), so a cancellation or a failed renewal
 * is seen without webhooks.
 */
import { getTenant, updateTenant } from "../multi-tenant/d1-registry.js";

const API = "https://api.stripe.com/v1";
export const PRICE_PLN = () => Number(process.env.NETWORK_PLAN_PRICE_PLN) || 149;
export const stripeKey = () => (process.env.STRIPE_SECRET_KEY || "").trim();

export async function stripe(path: string, init?: { method?: string; form?: Record<string, string> }): Promise<any> {
  const r = await fetch(`${API}${path}`, {
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
export const forgetSubscription = (tenantId: string) => subCache.delete(tenantId);

/** The panel is open: a subscription, or a business let in without one (settings.billingExempt - support, pilots). */
export async function hasPanel(tenantId: string): Promise<boolean> {
  if (getTenant(tenantId)?.settings?.billingExempt === true) return true;
  return subscribed(tenantId);
}

/** The Checkout form shared by every way in: the plan, VAT included (STRIPE_TAX_RATE_ID), terms accepted. */
export function planForm(tenantId: string, label: string): Record<string, string> {
  const tax = (process.env.STRIPE_TAX_RATE_ID || "").trim();
  return {
    mode: "subscription", locale: "pl",
    "line_items[0][quantity]": "1",
    ...(process.env.STRIPE_PRICE_ID ? { "line_items[0][price]": String(process.env.STRIPE_PRICE_ID) } : {
      "line_items[0][price_data][currency]": "pln",
      "line_items[0][price_data][unit_amount]": String(Math.round(PRICE_PLN() * 100)),
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][price_data][tax_behavior]": "inclusive",
      "line_items[0][price_data][product_data][name]": "Whisp - panel firmy",
    }),
    ...(tax ? { "line_items[0][tax_rates][0]": tax } : {}),
    allow_promotion_codes: "true",
    "tax_id_collection[enabled]": "true", // the business's NIP on the invoice
    "custom_text[submit][message]": "Płacąc, akceptujesz Regulamin (whisp.so/regulamin) wraz z umową powierzenia przetwarzania danych.",
    client_reference_id: tenantId,
    "metadata[tenantId]": tenantId,
    "subscription_data[metadata][tenantId]": tenantId,
    "subscription_data[description]": `Whisp: ${label}`,
  };
}

/** Back from Checkout: the session checked with Stripe; paid -> the business's subscription is stored. */
export async function storePaidSession(tenantId: string, sessionId: string): Promise<boolean> {
  if (!stripeKey() || !sessionId) return false;
  const s = await stripe(`/checkout/sessions/${encodeURIComponent(sessionId)}`).catch(() => null);
  if (!s || s.metadata?.tenantId !== tenantId || s.status !== "complete" || !["paid", "no_payment_required"].includes(String(s.payment_status))) return false;
  const t = getTenant(tenantId);
  if (!t) return false;
  const settings = { ...(t.settings || {}), stripeCustomer: String(s.customer || ""), stripeSubscription: String(s.subscription || "") };
  updateTenant(t.id, { settings });
  forgetSubscription(tenantId);
  return true;
}

/** Checkout for a business signed in to its panel; back to the panel, where the payment is checked. */
export async function panelCheckout(tenantId: string, base: string): Promise<string> {
  const t = getTenant(tenantId);
  if (!t) throw new Error("not found");
  if (!stripeKey()) throw new Error("payments are not set up");
  const back = `${base}/dashboard`;
  const s = await stripe("/checkout/sessions", { method: "POST", form: {
    ...planForm(tenantId, t.brandName || t.domain || tenantId),
    ...(t.settings?.stripeCustomer ? { customer: String(t.settings.stripeCustomer) } : t.email?.includes("@") ? { customer_email: t.email } : {}),
    success_url: `${back}?checkout={CHECKOUT_SESSION_ID}`,
    cancel_url: back,
  } });
  return String(s.url);
}

/** Stripe's customer portal (invoices, card, cancel), back to `back`. */
export async function portal(tenantId: string, back: string): Promise<string> {
  const customer = String(getTenant(tenantId)?.settings?.stripeCustomer || "");
  if (!customer || !stripeKey()) throw new Error("no subscription");
  const s = await stripe("/billing_portal/sessions", { method: "POST", form: { customer, return_url: back, locale: "pl" } });
  return String(s.url);
}
