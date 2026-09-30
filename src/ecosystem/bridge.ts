/**
 * Ecosystem bridge: bot-to-bot inquiries. The customer, talking to business A's
 * bot, wants to order from / send a request to business B that A's bot has just
 * recommended (answerViaPartner). A's bot then talks to B's bot: B's own "in
 * chat" form (collect flow, src/flows/collect.ts) gathers the details and shows
 * the summary, and nothing reaches B's owner before the customer confirms it -
 * that confirmation is the customer's consent to hand their details over.
 *
 * While the bridge is open, the customer's messages go to B's bot exactly as
 * they wrote them (B's bot keeps the customer's language) and B's replies are
 * shown attributed. The customer's earlier words go along with the first
 * message, so B's form picks up what they already said instead of asking again.
 * Choosing B is one Jev call, made only when this session has recommendations.
 */
import { jevPickOption } from "../llm/jev.js";
import type { ChatResponse } from "../llm/chat.js";

export interface BridgeDeps {
  askerId: string;
  askerBrand: () => string;
  /** The business's active "in chat" flow id (its own, or a default inquiry form). */
  ensureFlow: (bizId: string) => Promise<string>;
  /** One message to the business's bot, in the bridge's session. */
  talk: (bizId: string, key: string, text: string, opts?: { startFlowId?: string; via?: { tenantId: string; brand: string; sessionKey: string } }) => Promise<ChatResponse>;
}

interface Recommendation { items: { tenantId: string; label: string }[]; customerWords: string[]; at: number }
interface OpenBridge { bizId: string; label: string; key: string; at: number }

const TTL_MS = 30 * 60 * 1000; // same idle limit as the business's form session
const MAX_SESSIONS = 2000;

export class EcosystemBridge {
  private recommended = new Map<string, Recommendation>();
  private open = new Map<string, OpenBridge>();

  constructor(private deps: BridgeDeps) {}

  /** answerViaPartner recommended these businesses in this customer session. */
  remember(sessionKey: string, items: { tenantId: string; label: string }[], customerWords: string[]): void {
    this.prune();
    this.recommended.set(sessionKey, { items, customerWords: customerWords.filter(Boolean).slice(-3), at: Date.now() });
  }

  /**
   * The bridge's reply to this customer message, or null when the message is not
   * for a recommended business (normal chat continues).
   */
  async handle(sessionKey: string, message: string): Promise<ChatResponse | null> {
    const now = Date.now();
    const b = this.open.get(sessionKey);
    if (b && now - b.at < TTL_MS) {
      b.at = now;
      return this.relay(sessionKey, b, await this.deps.talk(b.bizId, b.key, message));
    }
    if (b) this.open.delete(sessionKey);

    const rec = this.recommended.get(sessionKey);
    if (!rec || now - rec.at > TTL_MS) return null;
    const pick = await jevPickOption(
      "The visitor was just recommended the businesses in the options. Does their `message` ask to order from, book, contact or send a request to one of them? Choose that business; choose none if the message is about something else or does not pick one.",
      message,
      rec.items.map((i) => i.label),
      "None - not asking to contact any of them",
    );
    if (!pick || pick.index < 0 || pick.ambiguous.length > 1) return null;
    const biz = rec.items[pick.index];

    let flowId: string;
    try { flowId = await this.deps.ensureFlow(biz.tenantId); }
    catch (e) { console.warn(`[bridge] ${this.deps.askerId} -> ${biz.tenantId}: no form: ${(e as Error).message}`); return null; }
    const opened: OpenBridge = { bizId: biz.tenantId, label: biz.label, key: `eco:${this.deps.askerId}:${sessionKey}:${biz.tenantId}`, at: now };
    this.open.set(sessionKey, opened);
    this.recommended.delete(sessionKey);
    // The customer's own words (their need + this message) start B's form.
    const first = [...rec.customerWords, message].join("\n");
    console.log(`[bridge] ${this.deps.askerId} -> ${biz.tenantId}: opened for ${sessionKey}`);
    const r = await this.deps.talk(biz.tenantId, opened.key, first, {
      startFlowId: flowId,
      via: { tenantId: this.deps.askerId, brand: this.deps.askerBrand(), sessionKey },
    });
    return this.relay(sessionKey, opened, r);
  }

  isOpen(sessionKey: string): boolean {
    const b = this.open.get(sessionKey);
    return !!b && Date.now() - b.at < TTL_MS;
  }

  private relay(sessionKey: string, b: OpenBridge, r: ChatResponse): ChatResponse {
    const stage = r.collect?.stage;
    // No form session on B's side (it ended, or was lost on a restart) or it is done.
    if (!stage || stage === "sent" || stage === "cancelled" || stage === "failed") {
      this.open.delete(sessionKey);
      console.log(`[bridge] ${this.deps.askerId} -> ${b.bizId}: closed (${stage || "no form session"})`);
    }
    return {
      message: `**${b.label}:** ${r.message}`,
      sources: r.sources || [],
      grounded: true,
      partners: [{ tenantId: b.bizId, label: b.label }],
      bridge: { tenantId: b.bizId, label: b.label, stage: stage || "closed" },
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.recommended) if (now - v.at > TTL_MS) this.recommended.delete(k);
    for (const [k, v] of this.open) if (now - v.at > TTL_MS) this.open.delete(k);
    while (this.recommended.size > MAX_SESSIONS) this.recommended.delete(this.recommended.keys().next().value!);
  }
}
