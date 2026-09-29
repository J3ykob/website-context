/**
 * Ecosystem member, one invocation per business. The serving tier broadcasts a
 * visitor's question (that another business's bot could not answer) to every
 * member of the ecosystem as parallel calls to this Worker; each call decides
 * for ONE business, from that business's own knowledge only:
 *
 *   1. its own passages, found the way its own bot finds them: Vectorize query
 *      restricted to the tenant (question vector computed once by the server),
 *      then the Jev catalog stage over its knowledge-catalog.json (R2);
 *   2. its own Jev gate on those passages, as in the bot's factCheck - below
 *      JEV_GATE_MIN it declines;
 *   3. its answer: written only from those passages + its official contact
 *      facts (context-meta.json in R2), by a Workers AI model (ANSWER_MODEL,
 *      nemotron-3-120b by default - picked on a 4-language battery), then checked
 *      by Jev to actually give the visitor what they asked (a "we don't do that"
 *      reply is declined).
 *
 * POST /evaluate  X-Member-Key: <MEMBER_KEY>
 *   { tenantId, label, question, messages: [{role, content}], vector?: number[] }
 *   (vector = bge-m3 embedding of the question; embedded here when omitted)
 * -> { can: boolean, relevance: number|null, fulfils?: number|null, answer?: string, sources?: {url,title}[] }
 */
import { jevPassageRelevance, jevReplyFulfils } from "../../../src/llm/jev.js";
import { retrieveFromCatalog, type KnowledgeCatalog, type CatalogChunk } from "../../../src/knowledge/catalog.js";

export interface Env {
  AI: Ai;
  VECTORIZE: Vectorize;
  R2: R2Bucket;
  MEMBER_KEY: string;
  JEV_GATE_MIN?: string;
  ANSWER_MODEL?: string;
}

interface EvaluateRequest {
  tenantId: string;
  label: string;
  question: string;
  messages: { role: "user" | "assistant"; content: string }[];
  vector?: number[];
}

const TOP_K = 15;        // same as the bot's retrieval
const MAX_PASSAGES = 12;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function loadCatalog(env: Env, tenantId: string): Promise<KnowledgeCatalog | null> {
  try {
    const obj = await env.R2.get(`tenants/${tenantId}/knowledge-catalog.json`);
    return obj ? (JSON.parse(await obj.text()) as KnowledgeCatalog) : null;
  } catch {
    return null;
  }
}

// Vector ids are "<tenant or md5 prefix>__<chunk id>"; the catalog keys chunks by chunk id.
const bareId = (vectorId: string) => { const i = vectorId.indexOf("__"); return i >= 0 ? vectorId.slice(i + 2) : vectorId; };

type Passage = { content: string; url: string; title: string; score: number | null };

// The bot's own retrieval + gate (chat.ts retrieveContext/catalogRetrieve + factCheck),
// without the answer generation. Returns the passages that answer the question.
async function ownKnowledge(env: Env, tenantId: string, question: string, vector: number[], gateMin: number): Promise<{ relevance: number | null; confirmed: Passage[] }> {
  const res = await env.VECTORIZE.query(vector, { topK: TOP_K, filter: { tenant: tenantId }, returnMetadata: "all" });
  const vectorHits: CatalogChunk[] = res.matches
    .map((m) => ({ id: bareId(m.id), catalogId: "", content: String(m.metadata?.content || ""), url: String(m.metadata?.url || ""), title: String(m.metadata?.title || ""), type: String(m.metadata?.type || "") }))
    .filter((h) => h.content.trim());

  // Catalog stage: Jev picks the relevant catalogs and judges their chunks together
  // with the vector hits, so a fact filed under another topic is still found.
  const catalog = await loadCatalog(env, tenantId);
  if (catalog) {
    const byId = new Map(catalog.chunks.map((c) => [c.id, c]));
    const r = await retrieveFromCatalog(question, catalog, vectorHits.map((h) => byId.get(h.id) || h));
    if (r) {
      const scored = r.hits.slice(0, 25).map((h) => ({ content: h.chunk.content, url: h.chunk.url, title: h.chunk.title, score: h.score }));
      const best = scored.length ? Math.max(...scored.map((p) => p.score)) : Math.max(0, ...r.scores.values());
      return { relevance: best, confirmed: scored.filter((p) => p.score >= gateMin).slice(0, MAX_PASSAGES) };
    }
  }

  // No catalog (or Jev unavailable for it): judge the vector hits directly.
  if (vectorHits.length === 0) return { relevance: 0, confirmed: [] };
  const scores = await jevPassageRelevance(question, vectorHits.slice(0, MAX_PASSAGES).map((h) => h.content.slice(0, 1500)));
  if (!scores) return { relevance: null, confirmed: [] };
  const passages = vectorHits.slice(0, MAX_PASSAGES).map((h, i) => ({ content: h.content, url: h.url, title: h.title, score: scores[i] }));
  return { relevance: Math.max(0, ...scores), confirmed: passages.filter((p) => (p.score ?? 0) >= gateMin) };
}

async function officialContact(env: Env, tenantId: string): Promise<string> {
  try {
    const obj = await env.R2.get(`tenants/${tenantId}/context-meta.json`);
    if (!obj) return "";
    const info = (JSON.parse(await obj.text()) as any)?.officialInfo || {};
    return [
      info.primaryPhone?.value && `Phone: ${info.primaryPhone.value}`,
      info.primaryEmail?.value && `Email: ${info.primaryEmail.value}`,
      info.primaryAddress?.value && `Address: ${info.primaryAddress.value}`,
      info.openingHours?.value && `Hours: ${info.openingHours.value}`,
    ].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

async function evaluate(req: EvaluateRequest, env: Env): Promise<Record<string, unknown>> {
  const gateMin = Number(env.JEV_GATE_MIN) || 0.5;

  // 1-2. This business's own passages and its own Jev gate. Without Jev it
  //      declines (fail closed: the asking bot then gives its own honest reply).
  const vector = req.vector || ((await env.AI.run("@cf/baai/bge-m3", { text: [req.question] })) as any).data[0];
  const { relevance, confirmed } = await ownKnowledge(env, req.tenantId, req.question, vector, gateMin);
  if (confirmed.length === 0) return { can: false, relevance };

  // 3. Its answer, from its passages and contact facts only.
  const contact = await officialContact(env, req.tenantId);
  const system =
    `You are the assistant of the business "${req.label}". Another business asked you, on behalf of its website visitor, the visitor's question. ` +
    `The excerpts from your website below were checked and DO contain the answer - answer the question from them, using only them${contact ? " and your official contact details" : ""}. ` +
    `Speak as the business (we/our), in 1-4 full sentences, and include how to reach you. Add no facts that are not in the excerpts. ` +
    `Reply in the SAME language as the visitor's latest message; translate what the excerpts say into it, keeping names, addresses, phone numbers, prices and codes exactly as written.\n\n` +
    confirmed.map((h, i) => `[${i + 1}] ${h.title}\n${h.content.slice(0, 1500)}`).join("\n\n") +
    (contact ? `\n\nOfficial contact details:\n${contact}` : "");
  const out: any = await env.AI.run((env.ANSWER_MODEL || "@cf/nvidia/nemotron-3-120b-a12b") as any, {
    messages: [{ role: "system", content: system }, ...req.messages.slice(-4)],
    max_tokens: 500,
    temperature: 0.2,
    // Reasoning off: same answers, ~2 s instead of ~8 s.
    chat_template_kwargs: { enable_thinking: false, thinking: false },
  } as any);
  const reply = String(out?.choices?.[0]?.message?.content ?? out?.response ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!reply) return { can: false, relevance };

  const fulfils = await jevReplyFulfils(req.question, reply);
  // draft: the declined reply, for diagnosing declines (the server ignores it).
  if (fulfils === null || fulfils < gateMin) return { can: false, relevance, fulfils, draft: reply.slice(0, 600) };
  const sources = [...new Map(confirmed.filter((h) => h.url).map((h) => [h.url, { url: h.url, title: h.title }])).values()];
  return { can: true, relevance, fulfils, answer: reply, sources };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    if (request.method !== "POST" || url.pathname !== "/evaluate") return json({ error: "not found" }, 404);
    if (!env.MEMBER_KEY || request.headers.get("X-Member-Key") !== env.MEMBER_KEY) return json({ error: "unauthorized" }, 401);
    let body: EvaluateRequest;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!body?.tenantId || !body.question || (body.vector !== undefined && !Array.isArray(body.vector)) || !Array.isArray(body.messages)) return json({ error: "bad request" }, 400);
    try {
      return json(await evaluate(body, env));
    } catch (e) {
      return json({ can: false, error: (e as Error).message.slice(0, 200) }, 500);
    }
  },
};
