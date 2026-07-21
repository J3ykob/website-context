/**
 * Intent-analysis engine — turns a tenant's raw visitor questions into the
 * handful of THEMES a site owner actually cares about ("what are people asking
 * my bot about?"). Emergent per-tenant clustering (no fixed taxonomy) so it fits
 * any business — a hotel, a law firm, a software house all get their own themes.
 *
 * Follows the store's "derive on read" philosophy: no new columns. We read the
 * user messages + the gap journal, cluster them with one LLM call, and cache the
 * result per tenant (recompute when the message count changes or the TTL lapses)
 * so the dashboard fetch is cheap and the LLM cost is paid at most once per window.
 */
import { getMessages, getUnknownQuestions } from "../storage/conversation-store.js";
import { OpenRouterProvider } from "../llm/openrouter-provider.js";

export interface IntentTheme {
  label: string;      // owner-friendly, in the questions' own language
  count: number;      // how many visitor questions fall under this theme
  gapCount: number;   // how many of those the bot could NOT answer (knowledge gaps)
  examples: string[]; // up to 3 verbatim example questions
}

export interface IntentAnalysis {
  themes: IntentTheme[];
  totalQuestions: number; // distinct meaningful questions analysed
  sampleSize: number;     // raw user messages considered
  truncated: boolean;     // hit the MAX_Q cap (older messages not analysed)
  analyzedAt: string;
}

interface CacheEntry { analysis: IntentAnalysis; msgCount: number; at: number }
const cache = new Map<string, CacheEntry>();
const TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_Q = 500;                 // cap questions per analysis (prompt budget)

const EMPTY = (sample: number): IntentAnalysis => ({
  themes: [], totalQuestions: 0, sampleSize: sample, truncated: false, analyzedAt: new Date().toISOString(),
});

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// Drop greetings, one-word noise, and obvious test pings so themes stay signal.
function isMeaningful(content: string): boolean {
  const c = content.trim();
  if (c.length < 3) return false;
  if (/^(hi|hej|hey|hello|cześć|siema|dzień dobry|witam|test|ok|okay|thx|dzięki|thanks|spoko)[\s!.,?]*$/i.test(c)) return false;
  return true;
}

/** Public: cached, per-tenant theme analysis of visitor questions. */
export async function analyzeIntents(tenantId: string, opts: { force?: boolean } = {}): Promise<IntentAnalysis> {
  const userMsgs = await getMessages(tenantId, { role: "user", limit: MAX_Q });
  const cached = cache.get(tenantId);
  if (!opts.force && cached && cached.msgCount === userMsgs.length && Date.now() - cached.at < TTL_MS) {
    return cached.analysis;
  }

  // Distinct, meaningful questions (preserve first-seen surface form).
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const m of userMsgs) {
    const c = (m.content || "").trim();
    if (!isMeaningful(c)) continue;
    const n = normalize(c);
    if (seen.has(n)) continue;
    seen.add(n);
    uniq.push(c);
  }

  if (uniq.length === 0) {
    const empty = EMPTY(userMsgs.length);
    cache.set(tenantId, { analysis: empty, msgCount: userMsgs.length, at: Date.now() });
    return empty;
  }

  const gapQuestions = (await getUnknownQuestions(tenantId)).map((g) => g.question).filter(Boolean);

  let analysis: IntentAnalysis;
  try {
    analysis = await clusterWithLLM(uniq, gapQuestions, userMsgs.length, userMsgs.length >= MAX_Q);
  } catch (e: any) {
    console.error(`[intent-engine] cluster failed (${tenantId}): ${String(e?.message || e).slice(0, 160)}`);
    // Fall back to the stale cache if we have one, else empty.
    return cached?.analysis || EMPTY(userMsgs.length);
  }

  cache.set(tenantId, { analysis, msgCount: userMsgs.length, at: Date.now() });
  return analysis;
}

async function clusterWithLLM(
  questions: string[], gaps: string[], sampleSize: number, truncated: boolean
): Promise<IntentAnalysis> {
  const provider = new OpenRouterProvider();

  // Tag each item so the model can compute per-theme gap share. Gap restatements
  // are the bot's own phrasing of what it lacked — semantically clusterable next
  // to the raw questions.
  const qLines = questions.map((q) => `Q: ${q}`);
  const gLines = gaps.map((g) => `GAP: ${g}`);
  const corpus = [...qLines, ...gLines].join("\n");

  const system =
    "You analyse the questions visitors typed to a business's website chatbot and group them into the few THEMES the business owner should see — what people most want to know. " +
    "Lines prefixed 'Q:' are visitor questions. Lines prefixed 'GAP:' are questions the bot could NOT answer (missing info). " +
    "Return STRICT JSON only, no prose, no markdown fences.";

  const instruction =
    `${corpus}\n\n` +
    `Group the lines above into 4-8 themes. Return JSON exactly:\n` +
    `{"themes":[{"label":"...","count":N,"gapCount":N,"examples":["...","..."]}]}\n` +
    `Rules:\n` +
    `- label: 1-4 words, owner-friendly, in the SAME language as the questions.\n` +
    `- count: total lines (Q + GAP) in the theme. gapCount: how many were GAP.\n` +
    `- examples: up to 3 items copied VERBATIM from the lines (without the Q:/GAP: prefix).\n` +
    `- Every line belongs to exactly one theme; sort themes by count descending; merge near-duplicates.\n` +
    `- Skip pure greetings/chit-chat rather than making a theme for them.`;

  const { content } = await provider.chat(
    [ { role: "system", content: system }, { role: "user", content: instruction } ],
    { maxTokens: 1400, temperature: 0.2 }
  );

  const parsed = extractJson(content);
  const rawThemes: any[] = Array.isArray(parsed?.themes) ? parsed.themes : [];
  const themes: IntentTheme[] = rawThemes
    .map((t) => ({
      label: String(t?.label || "").trim().slice(0, 60),
      count: Math.max(0, Math.round(Number(t?.count) || 0)),
      gapCount: Math.max(0, Math.round(Number(t?.gapCount) || 0)),
      examples: Array.isArray(t?.examples) ? t.examples.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 3) : [],
    }))
    .filter((t) => t.label && t.count > 0)
    .map((t) => ({ ...t, gapCount: Math.min(t.gapCount, t.count) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    themes,
    totalQuestions: questions.length,
    sampleSize,
    truncated,
    analyzedAt: new Date().toISOString(),
  };
}

// Tolerant JSON extraction — strips ``` fences and grabs the outermost object.
function extractJson(text: string): any {
  if (!text) return null;
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

/** Test/ops seam: drop the cache (e.g. after a gap-journal purge). */
export function invalidateIntents(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId); else cache.clear();
}
