/**
 * Ecosystem broadcast. When a business's own content has nothing on a visitor's
 * question, EVERY other business of its ecosystem (tenant.settings.ecosystem)
 * gets the question, and each one decides for itself - with the same retrieval
 * and Jev answerability gate its own bot uses on its own site
 * (WebsiteChat.canAnswer) - whether it can answer. The ones that confirm answer
 * through their own bot (grounded in their own site, never asking further).
 */
import { listTenants } from "../multi-tenant/tenant-registry.js";
import type { ChatMessage, ChatResponse, WebsiteChat } from "../llm/chat.js";

export interface EcosystemAnswer { tenantId: string; label: string; answer: ChatResponse }

const PARALLEL = 8;           // members evaluated at once
const MEMBER_TIMEOUT_MS = 20000;
const MAX_RELAYED = 3;        // answers relayed to the visitor (keeps the reply readable)

export function ecosystemOf(tenant: { settings?: any } | null | undefined): string {
  const e = tenant?.settings?.ecosystem;
  return typeof e === "string" ? e.trim() : "";
}

function labelOf(t: { brandName: string | null; domain: string; settings?: any }): string {
  return t.settings?.siteCard?.brand || t.brandName || t.domain.replace(/^www\./, "");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

// Runs fn over items with at most `limit` in flight.
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export async function askEcosystem(
  fromTenantId: string,
  ecosystem: string,
  messages: ChatMessage[],
  chatFor: (tenantId: string) => Promise<WebsiteChat>,
): Promise<EcosystemAnswer[]> {
  const question = messages.findLast((m) => m.role === "user")?.content?.trim() || "";
  if (!ecosystem || question.length < 3) return [];
  const members = listTenants().filter((t) => t.id !== fromTenantId && t.status === "active" && ecosystemOf(t) === ecosystem);
  if (members.length === 0) return [];
  const t0 = Date.now();

  // Every member judges the question against its own knowledge, then the ones
  // that confirmed answer it through their own bot.
  const results = await mapLimited(members, PARALLEL, async (m) => {
    try {
      const chat = await chatFor(m.id);
      const can = await withTimeout(chat.canAnswer(question), MEMBER_TIMEOUT_MS);
      if (!can) return { id: m.id, can: can === null ? "timeout" : "no", answer: null };
      const answer = await withTimeout(chat.chat(messages.slice(-4), `ecosystem:${fromTenantId}:${Date.now()}`, undefined, { noPartners: true }), MEMBER_TIMEOUT_MS);
      const ok = !!answer && answer.grounded !== false && !answer.unknownQuestion && !!answer.message.trim();
      return { id: m.id, can: "yes", answer: ok ? { tenantId: m.id, label: labelOf(m), answer: answer! } : null };
    } catch (e) {
      console.warn(`[ecosystem] ${fromTenantId} -> ${m.id} failed: ${(e as Error).message}`);
      return { id: m.id, can: "error", answer: null };
    }
  });
  const answers = results.map((r) => r.answer).filter((a): a is EcosystemAnswer => a !== null);
  const yes = results.filter((r) => r.can === "yes").map((r) => r.id);
  const other = results.filter((r) => r.can === "timeout" || r.can === "error").map((r) => `${r.id}:${r.can}`);
  console.log(`[ecosystem] ${fromTenantId}: asked ${members.length}, can answer: ${yes.join(", ") || "none"}${other.length ? `, ${other.join(" ")}` : ""} -> relaying ${Math.min(answers.length, MAX_RELAYED)} (${Date.now() - t0}ms)`);
  return answers.slice(0, MAX_RELAYED);
}
