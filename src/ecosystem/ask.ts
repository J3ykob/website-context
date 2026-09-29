/**
 * Ecosystem broadcast. When a business's own content has nothing on a visitor's
 * question, EVERY other business of its ecosystem (tenant.settings.ecosystem)
 * gets the question, and each one decides for itself - with the same retrieval
 * and Jev answerability gate its own bot uses on its own site
 * (WebsiteChat.canAnswer) - whether it can answer. The ones that confirm answer
 * through their own bot (grounded in their own site, never asking further), and
 * only replies that actually give the visitor what they asked for are relayed.
 *
 * Serverless path (default): one call to the ecosystem-member Worker PER MEMBER
 * (workers/ecosystem-member), all in parallel, so the serving tier loads nothing
 * and the broadcast scales with the ecosystem. ECOSYSTEM_WORKER_URL=off falls
 * back to evaluating the members' bots in this process.
 */
import { createHash } from "crypto";
import { listTenants } from "../multi-tenant/tenant-registry.js";
import { jevReplyFulfils } from "../llm/jev.js";
import type { ChatMessage, ChatResponse, WebsiteChat } from "../llm/chat.js";

export interface EcosystemAnswer { tenantId: string; label: string; answer: ChatResponse }

const PARALLEL = 8;           // members evaluated at once (in-process path)
const WORKER_PARALLEL = 50;   // concurrent Worker calls
const WORKER_URL = process.env.ECOSYSTEM_WORKER_URL || "https://ecosystem-member.kubalol7982.workers.dev";
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
  deps: { chatFor: (tenantId: string) => Promise<WebsiteChat>; embed: (texts: string[]) => Promise<number[][]> },
  onStart?: () => void,
): Promise<EcosystemAnswer[]> {
  const question = messages.findLast((m) => m.role === "user")?.content?.trim() || "";
  if (!ecosystem || question.length < 3) return [];
  const members = listTenants().filter((t) => t.id !== fromTenantId && t.status === "active" && ecosystemOf(t) === ecosystem);
  if (members.length === 0) return [];
  onStart?.();
  const t0 = Date.now();

  const results = WORKER_URL !== "off"
    ? await viaWorker(members, question, messages, deps.embed)
    : await inProcess(members, question, messages, fromTenantId, deps.chatFor);
  const answers = results.map((r) => r.answer).filter((a): a is EcosystemAnswer => a !== null);
  const yes = results.filter((r) => r.can === "yes").map((r) => r.id);
  const other = results.filter((r) => r.can !== "yes" && r.can !== "no").map((r) => `${r.id}:${r.can}`);
  console.log(`[ecosystem] ${fromTenantId}: asked ${members.length}${WORKER_URL !== "off" ? " (serverless)" : ""}, can answer: ${yes.join(", ") || "none"}${other.length ? `, ${other.join(" ")}` : ""} -> relaying ${Math.min(answers.length, MAX_RELAYED)} (${Date.now() - t0}ms)`);
  return answers.slice(0, MAX_RELAYED);
}

type MemberResult = { id: string; can: string; answer: EcosystemAnswer | null };
type Member = ReturnType<typeof listTenants>[number];

// Key the Worker checks; derived from the server's admin secret so no extra
// secret has to be provisioned on the serving tier.
function memberKey(): string {
  return createHash("sha256").update(`${process.env.ADMIN_SECRET || ""}:ecosystem-member`).digest("hex");
}

// Serverless: one Worker invocation per member, each deciding from that member's
// own passages + Jev gate (workers/ecosystem-member). The question is embedded once.
async function viaWorker(members: Member[], question: string, messages: ChatMessage[], embed: (texts: string[]) => Promise<number[][]>): Promise<MemberResult[]> {
  const [vector] = await embed([question]);
  const key = memberKey();
  return mapLimited(members, WORKER_PARALLEL, async (m): Promise<MemberResult> => {
    try {
      const r = await fetch(`${WORKER_URL}/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Member-Key": key },
        body: JSON.stringify({ tenantId: m.id, label: labelOf(m), question, messages: messages.slice(-4), vector }),
        signal: AbortSignal.timeout(MEMBER_TIMEOUT_MS),
      });
      const d = (await r.json()) as any;
      if (!r.ok) return { id: m.id, can: `error:${r.status}`, answer: null };
      if (!d.can) return { id: m.id, can: d.fulfils !== undefined ? `declined:${typeof d.fulfils === "number" ? d.fulfils.toFixed(2) : "?"}` : "no", answer: null };
      return { id: m.id, can: "yes", answer: { tenantId: m.id, label: labelOf(m), answer: { message: String(d.answer), sources: Array.isArray(d.sources) ? d.sources : [], grounded: true } } };
    } catch (e) {
      return { id: m.id, can: (e as Error).name === "TimeoutError" ? "timeout" : "error", answer: null };
    }
  });
}

// In-process: every member's own bot judges (canAnswer) and answers.
async function inProcess(members: Member[], question: string, messages: ChatMessage[], fromTenantId: string, chatFor: (tenantId: string) => Promise<WebsiteChat>): Promise<MemberResult[]> {
  return mapLimited(members, PARALLEL, async (m): Promise<MemberResult> => {
    try {
      const chat = await chatFor(m.id);
      const can = await withTimeout(chat.canAnswer(question), MEMBER_TIMEOUT_MS);
      if (!can) return { id: m.id, can: can === null ? "timeout" : "no", answer: null };
      const answer = await withTimeout(chat.chat(messages.slice(-4), `ecosystem:${fromTenantId}:${Date.now()}`, undefined, { noPartners: true }), MEMBER_TIMEOUT_MS);
      if (!answer || answer.grounded === false || answer.unknownQuestion || !answer.message.trim()) return { id: m.id, can: "no-answer", answer: null };
      // Relevant knowledge is not the same as a yes: relay only a reply that gives
      // the visitor what they asked for (not "we don't do that" / "no information").
      // Without Jev nothing is relayed - the visitor gets our own honest reply.
      const fulfils = await jevReplyFulfils(question, answer.message);
      if (fulfils === null || fulfils < (Number(process.env.JEV_GATE_MIN) || 0.5)) return { id: m.id, can: `declined:${fulfils?.toFixed(2) ?? "?"}`, answer: null };
      return { id: m.id, can: "yes", answer: { tenantId: m.id, label: labelOf(m), answer } };
    } catch (e) {
      console.warn(`[ecosystem] ${fromTenantId} -> ${m.id} failed: ${(e as Error).message}`);
      return { id: m.id, can: "error", answer: null };
    }
  });
}
