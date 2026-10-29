/**
 * The chat's side of the network: when a business's own content has nothing on a visitor's need, the
 * network's one search (src/network/find.ts - the same the customer's project uses for offers) finds the
 * businesses that offer it; the best few are relayed with their matched items, excerpts and official
 * contact, and the asking bot writes one reply from them.
 */
import type { EcosystemPlan } from "./rank.js";
import type { ChatMessage } from "../llm/chat.js";

export interface EcosystemMatch {
  tenantId: string;
  label: string;
  plan: EcosystemPlan;
  offers: number;
  vector: number;
  passages: { content: string; url: string; title: string }[];
  contact: string;
}

const MAX_RELAYED = 3;         // businesses relayed to the visitor
const PASSAGES = 3;            // excerpts per business

export function ecosystemOf(tenant: { settings?: any } | null | undefined): string {
  const e = tenant?.settings?.ecosystem;
  return typeof e === "string" ? e.trim() : "";
}

// Official contact facts from the scrape (context-meta.json), cached briefly.
const contactCache = new Map<string, { at: number; text: string }>();
async function contactOf(tenantId: string): Promise<string> {
  const hit = contactCache.get(tenantId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.text;
  let text = "";
  try {
    const { downloadTenantFile } = await import("../storage/r2.js");
    const buf = await downloadTenantFile(tenantId, "context-meta.json");
    const info = buf ? JSON.parse(buf.toString("utf-8"))?.officialInfo || {} : {};
    text = [
      info.primaryPhone?.value && `phone ${info.primaryPhone.value}`,
      info.primaryEmail?.value && `email ${info.primaryEmail.value}`,
      info.primaryAddress?.value && `address ${info.primaryAddress.value}`,
    ].filter(Boolean).join(", ");
  } catch {}
  contactCache.set(tenantId, { at: Date.now(), text });
  return text;
}

export async function askEcosystem(
  fromTenantId: string,
  ecosystem: string,
  messages: ChatMessage[],
  _deps: { embed: (texts: string[]) => Promise<number[][]> },
  onStart?: () => void,
): Promise<EcosystemMatch[]> {
  const question = messages.findLast((m) => m.role === "user")?.content?.trim() || "";
  if (!ecosystem || question.length < 3) return [];
  onStart?.();
  // The network's one search (src/network/find.ts - the same the customer's project uses for offers).
  const { findBusinesses } = await import("../network/find.js");
  const r = await findBusinesses(question, ecosystem, { exclude: fromTenantId }).catch(() => null);
  if (!r?.hits.length) return [];
  // The best few businesses to recommend: priced matches first, then confidence (+ plan boost) - one per business.
  const seen = new Set<string>();
  const best = r.hits.filter((h) => !seen.has(h.tenantId) && seen.add(h.tenantId)).slice(0, MAX_RELAYED);
  const matches: EcosystemMatch[] = await Promise.all(best.map(async (h) => ({
    tenantId: h.tenantId,
    label: h.label,
    plan: h.plan,
    offers: h.offers,
    vector: h.vector,
    // Its matched items (with prices) and its own page excerpts: what the reply may say about it.
    passages: [...h.items.slice(0, 4).map((i) => ({ content: `${i.name}${i.price_value !== null ? ` - ${i.price_value} ${i.currency}${i.price_max ? `-${i.price_max}` : ""}` : ""}${i.description ? `. ${i.description.slice(0, 200)}` : ""}`, url: i.url || "", title: i.name })), ...h.passages].slice(0, PASSAGES + 2),
    contact: await contactOf(h.tenantId),
  })));
  console.log(`[ecosystem] ${fromTenantId}: ${r.parts.length} part(s), ${r.asked} judged -> relaying ${matches.map((x) => `${x.tenantId}${x.plan !== "free" ? `(${x.plan})` : ""}`).join(", ") || "none"} (${r.ms} ms)`);
  return matches;
}
