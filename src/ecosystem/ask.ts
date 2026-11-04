/**
 * The chat's side of the network: for the parts of a visitor's need the business does not have itself
 * (src/network/coverage.ts), the network's one search (src/network/find.ts - the same the customer's project
 * uses for offers) finds the businesses that offer them; the best few are relayed with their matched items,
 * excerpts and official contact, and the asking bot writes one reply from them.
 */
import type { EcosystemPlan } from "./rank.js";
import type { ChatMessage } from "../llm/chat.js";

export interface EcosystemMatch {
  tenantId: string;
  label: string;
  plan: EcosystemPlan;
  offers: number;
  vector: number;
  passages: { content: string; url: string; title: string; item?: boolean }[]; // item: one of its offer rows
  contact: string;
  parts: string[]; // the asked parts it was found for (the reply's evidence says what each business offers)
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
  parts?: string[], // only these parts of the need (the ones the asking business does not have); none = nothing to search
  // The parts whose hits are relayed, known later (the chat searches every part at once and keeps only the ones the
  // asking business does not have when its coverage comes - src/llm/chat.ts networkStart); absent = all searched parts.
  keep?: Promise<string[]>,
): Promise<EcosystemMatch[]> {
  const question = messages.findLast((m) => m.role === "user")?.content?.trim() || "";
  if (!ecosystem || question.length < 3 || (parts && !parts.length)) return [];
  onStart?.();
  // The network's one search (src/network/find.ts - the same the customer's project uses for offers).
  const { findBusinesses } = await import("../network/find.js");
  const r = await findBusinesses(question, ecosystem, { exclude: fromTenantId, parts }).catch(() => null);
  const kept = keep ? new Set(await keep.catch(() => [] as string[])) : null;
  // Hits for the asking business's own parts are dropped before anything is built from them (items, excerpts, parts).
  const hits = (r?.hits || []).filter((h) => !kept || kept.has(r!.parts[h.part]));
  if (!r || !hits.length) return [];
  // The best few businesses to recommend: priced matches first, then confidence (+ plan boost) - one per business.
  const seen = new Set<string>();
  const best = hits.filter((h) => !seen.has(h.tenantId) && seen.add(h.tenantId)).slice(0, MAX_RELAYED);
  const matches: EcosystemMatch[] = await Promise.all(best.map(async (h) => ({
    tenantId: h.tenantId,
    label: h.label,
    plan: h.plan,
    offers: h.offers,
    vector: h.vector,
    // Its matched items (with prices) and its own page excerpts: what the reply may say about it.
    passages: [...h.items.slice(0, 4).map((i) => ({ content: `${i.name}${i.price_value !== null ? ` - ${i.price_value} ${i.currency}${i.price_max ? `-${i.price_max}` : ""}` : ""}${i.description ? `. ${i.description.slice(0, 200)}` : ""}`, url: i.url || "", title: i.name, item: true })), ...h.passages].slice(0, PASSAGES + 2),
    contact: await contactOf(h.tenantId),
    parts: [...new Set(hits.filter((x) => x.tenantId === h.tenantId).map((x) => r.parts[x.part]))],
  })));
  console.log(`[ecosystem] ${fromTenantId}: ${r.parts.length} part(s), ${r.asked} judged -> relaying ${matches.map((x) => `${x.tenantId}${x.plan !== "free" ? `(${x.plan})` : ""}`).join(", ") || "none"} (${r.ms} ms)`);
  return matches;
}
