/**
 * Ecosystem broadcast. When a business's own content has nothing on a visitor's
 * question, every other business in its ecosystem (tenant.settings.ecosystem)
 * gets the question and decides from its OWN knowledge whether it can answer:
 *
 *   1. one embedding + one Vectorize query over all members' vectors finds the
 *      members that hold anything close to the question;
 *   2. each such member judges its own passages with the same Jev answerability
 *      gate its bot applies on its own site;
 *   3. only members that pass answer, through their own bot (grounded in their
 *      own site, never asking further members).
 *
 * The cost is one query regardless of how many businesses are in the ecosystem;
 * the per-member work happens only for the few candidates.
 */
import { CloudflareVectorizeStore } from "../embeddings/vectorize-store.js";
import { jevPassageRelevance } from "../llm/jev.js";
import { listTenants } from "../multi-tenant/tenant-registry.js";
import type { ChatMessage, ChatResponse, WebsiteChat } from "../llm/chat.js";

export interface EcosystemAnswer { tenantId: string; label: string; answer: ChatResponse }

const MAX_CANDIDATES = 4;   // members whose passages get judged
const MAX_ANSWERS = 2;      // members whose answers are relayed
const PASSAGES_PER_MEMBER = 4;

export function ecosystemOf(tenant: { settings?: any } | null | undefined): string {
  const e = tenant?.settings?.ecosystem;
  return typeof e === "string" ? e.trim() : "";
}

function labelOf(t: { brandName: string | null; domain: string; settings?: any }): string {
  return t.settings?.siteCard?.brand || t.brandName || t.domain.replace(/^www\./, "");
}

export async function askEcosystem(
  fromTenantId: string,
  ecosystem: string,
  messages: ChatMessage[],
  deps: { embed: (texts: string[]) => Promise<number[][]>; chatFor: (tenantId: string) => Promise<WebsiteChat> },
): Promise<EcosystemAnswer[]> {
  const question = messages.findLast((m) => m.role === "user")?.content?.trim() || "";
  if (!ecosystem || question.length < 3) return [];
  const members = listTenants().filter((t) => t.id !== fromTenantId && t.status === "active" && ecosystemOf(t) === ecosystem);
  if (members.length === 0) return [];
  const byId = new Map(members.map((t) => [t.id, t]));

  // 1. Which members hold anything close to the question (one query; $in is
  //    batched to stay well inside Vectorize filter limits).
  const [vector] = await deps.embed([question]);
  const store = new CloudflareVectorizeStore({ tenantId: fromTenantId });
  const ids = [...byId.keys()];
  const hits = (await Promise.all(
    Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => store.searchTenants(vector, ids.slice(i * 100, i * 100 + 100), 20)),
  )).flat();
  const passages = new Map<string, { best: number; texts: string[] }>();
  for (const h of hits.sort((a, b) => b.score - a.score)) {
    const p = passages.get(h.tenantId) || { best: h.score, texts: [] };
    if (p.texts.length < PASSAGES_PER_MEMBER && h.content.trim()) p.texts.push(h.content);
    passages.set(h.tenantId, p);
  }
  const candidates = [...passages.entries()].sort((a, b) => b[1].best - a[1].best).slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) return [];

  // 2. Each candidate judges its own passages (same gate as its own bot). Without
  //    Jev the candidate's bot decides alone in step 3 (grounded + no gap).
  const gateMin = Number(process.env.JEV_GATE_MIN) || 0.5;
  const judged = await Promise.all(candidates.map(async ([id, p]) => {
    const scores = await jevPassageRelevance(question, p.texts);
    return { id, relevance: scores ? Math.max(0, ...scores) : null };
  }));
  const confirmed = judged
    .filter((j) => j.relevance === null || j.relevance >= gateMin)
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
    .slice(0, MAX_ANSWERS);
  console.log(`[ecosystem] ${fromTenantId}: ${members.length} members, candidates ${judged.map((j) => `${j.id}=${j.relevance?.toFixed(2) ?? "?"}`).join(" ")} -> ${confirmed.length} answering`);

  // 3. Confirmed members answer through their own bot.
  const answers = await Promise.all(confirmed.map(async ({ id }) => {
    try {
      const chat = await deps.chatFor(id);
      const answer = await chat.chat(messages.slice(-4), `ecosystem:${fromTenantId}:${Date.now()}`, undefined, { noPartners: true });
      if (answer.grounded === false || answer.unknownQuestion || !answer.message.trim()) return null;
      return { tenantId: id, label: labelOf(byId.get(id)!), answer };
    } catch (e) {
      console.warn(`[ecosystem] ${fromTenantId} -> ${id} failed: ${(e as Error).message}`);
      return null;
    }
  }));
  return answers.filter((a): a is EcosystemAnswer => a !== null);
}
