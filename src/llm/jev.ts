/**
 * TypeSafe Jev (System One) client for the web chat's small decisions: the
 * answerability gate and flow-intent routing. Jev returns calibrated
 * probabilities for typed questions (Noul = P(yes), Choice = distribution over
 * options) in one call, ~400ms, billed per input token only ($0.042/M).
 *
 * Every helper returns null on missing key, HTTP error or timeout, so callers
 * fall back to the OpenRouter fast model and chat never breaks on a Jev outage.
 *
 * Env: JEV_API_KEY, JEV_MODEL (default jev-latest), JEV_TIMEOUT_MS (default 2500),
 * JEV_GATE_MIN (default 0.5).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { countJev, jevOffForTurn, jevTurnCount, noteJevCapped } from "./turn-usage.js";
import { logDecision } from "./decision-log.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

// Per-request Jev usage (tokens billed + calls), scoped so concurrent requests
// don't mix: wrap work in jevUsage.run({ inputTokens: 0, calls: 0 }, fn) and read
// the store afterwards. Hedged duplicate requests count once (the winner).
export interface JevUsage { inputTokens: number; calls: number }
export const jevUsage = new AsyncLocalStorage<JevUsage>();

export type JevQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> };

export interface JevChoiceAnswer { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevNoulAnswer { type: "noul"; noul: number }
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export function jevEnabled(): boolean {
  return !!process.env.JEV_API_KEY && !jevOffForTurn();
}

// TypeSafe latency is bimodal (from Render: ~80 ms, or 2-3.5 s in bursts for
// ~40% of calls, measured 2026-09-28). For calls with room (timeout >= 2 s),
// identical backup requests fire on a staggered schedule (JEV_HEDGE_SCHEDULE ms,
// default 300,800,1600,3000) while none has answered; the first answer wins and
// the rest are aborted. Requests are cheap, stalls are not. Short-budget callers
// (the voice bot, 450 ms) are never hedged.
export async function jevAsk(state: unknown, questions: Record<string, JevQuestion>, timeoutMs?: number): Promise<Record<string, JevAnswer> | null> {
  const key = process.env.JEV_API_KEY;
  if (!key || jevOffForTurn()) return null;
  // Per-turn cap: only against a runaway loop (JEV_TURN_MAX, default 400). A network question needs ~2 calls
  // per business in the network (31 for 16 businesses); the Warsaw base has 168 firms - 400 leaves room.
  // Jev costs ~$0.0001 per call, so the cap is about loops, not money (docs/limits.md).
  if (jevTurnCount() >= (Number(process.env.JEV_TURN_MAX) || 400)) { noteJevCapped(); return null; }
  const t0 = Date.now();
  const budget = timeoutMs ?? (Number(process.env.JEV_TIMEOUT_MS) || 2500);
  const schedule = (process.env.JEV_HEDGE_SCHEDULE || "300,800,1600,3000").split(",").map(Number).filter((n) => n > 0 && n < budget);
  const body = JSON.stringify({ model: process.env.JEV_MODEL || "jev-latest", state, questions });
  const controllers: AbortController[] = [];
  const attempt = async (): Promise<Record<string, JevAnswer>> => {
    const c = new AbortController();
    controllers.push(c);
    const r = await fetch(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, signal: c.signal });
    if (!r.ok) { jevOutcome(false, r.status); throw new Error(`HTTP ${r.status}`); }
    const json = (await r.json()) as any;
    const answers = json?.answers;
    if (!answers || typeof answers !== "object") throw new Error("no answers");
    const u = jevUsage.getStore();
    if (u) { u.inputTokens += Number(json?.usage?.input_tokens) || 0; u.calls++; }
    countJev(Number(json?.usage?.input_tokens) || 0, t0);
    jevOutcome(true);
    logDecision("jev", String(json?.model || process.env.JEV_MODEL || "jev-latest"), { state, questions }, answers);
    return answers;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hedges: ReturnType<typeof setTimeout>[] = [];
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), budget); });
    // First success wins; a failed attempt only loses once every attempt
    // (including the ones still scheduled) has failed.
    // Backups only for quick decisions (2-6 s budgets: router, checks); a big batch (page scoring) is
    // not sent five times over.
    const total = budget >= 2000 && budget <= 6000 ? 1 + schedule.length : 1;
    const firstOk = new Promise<Record<string, JevAnswer>>((resolve, reject) => {
      let failed = 0;
      const run = () => attempt().then(resolve, (e) => { if (++failed === total) reject(e); });
      run();
      if (total > 1) for (const ms of schedule) hedges.push(setTimeout(run, ms));
    });
    return await Promise.race([firstOk, timeout]);
  } catch (e: any) {
    console.warn(`[jev] ${e?.message || e} after ${Date.now() - t0}ms`);
    if (String(e?.message || e) === "timeout") jevOutcome(false, 0);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    for (const h of hedges) clearTimeout(h);
    for (const c of controllers) c.abort();
  }
}

/**
 * Per-passage answerability: P(passage answers the question) for each passage,
 * all asked in one request. Returns null when Jev is unavailable.
 */
export async function jevPassageRelevance(question: string, passages: string[]): Promise<number[] | null> {
  if (passages.length === 0) return [];
  const questions: Record<string, JevQuestion> = {};
  passages.forEach((_, i) => {
    questions[`p${i}`] = {
      type: "noul",
      instructions: `Does \`passages[${i}]\` contain information that answers \`question\` (fully, or for at least one location, product or case the question asks about)?`,
      criteria: {
        true: "The passage states the concrete facts needed to answer.",
        false: "The passage is off-topic or lacks the specific fact asked for.",
      },
    };
  });
  const answers = await jevAsk({ question, passages }, questions);
  if (!answers) return null;
  const out = passages.map((_, i) => {
    const a = answers[`p${i}`] as JevNoulAnswer | undefined;
    return a && typeof a.noul === "number" ? a.noul : NaN;
  });
  return out.some((v) => Number.isNaN(v)) ? null : out;
}

/**
 * Which option (by index) the message selects, or -1 for none. `ambiguous`
 * lists every option whose probability is within reach of the winner, so the
 * caller can ask the visitor to disambiguate. Returns null when Jev is unavailable.
 */
export async function jevPickOption(
  instructions: string,
  message: string,
  options: string[],
  noneLabel: string,
): Promise<{ index: number; confidence: number; ambiguous: number[] } | null> {
  if (options.length === 0) return { index: -1, confidence: 1, ambiguous: [] };
  const criteria: Record<string, string> = { none: noneLabel };
  options.forEach((o, i) => { criteria[`option_${i + 1}`] = o; });
  const answers = await jevAsk({ message }, { pick: { type: "choice", instructions, criteria } });
  const a = answers?.pick as JevChoiceAnswer | undefined;
  if (!a || typeof a.choice !== "string" || !a.probabilities) return null;
  const idx = (key: string) => (key.startsWith("option_") ? parseInt(key.slice(7), 10) - 1 : -1);
  const index = idx(a.choice);
  const top = a.probabilities[a.choice] ?? 0;
  const ambiguous = Object.entries(a.probabilities)
    .filter(([k, p]) => k !== "none" && p >= 0.3 && p >= top - 0.25)
    .sort((x, y) => y[1] - x[1])
    .map(([k]) => idx(k))
    .filter((i) => i >= 0 && i < options.length);
  return { index: index >= 0 && index < options.length ? index : -1, confidence: a.confidence ?? top, ambiguous };
}



/**
 * Ecosystem: for several businesses at once, P(their own excerpts show they offer,
 * sell, rent or do what `question` asks for) - one call for all candidates. A
 * business that only mentions the thing, says it doesn't do it, or is about
 * something else scores low. null when Jev is unavailable.
 */
export async function jevBusinessesOffer(question: string, businesses: { name: string; passages: string[] }[]): Promise<number[] | null> {
  if (businesses.length === 0) return [];
  // One question per excerpt (a business scores its best excerpt): judging each
  // excerpt alone is steadier than judging a business's excerpts glued together.
  const state: Record<string, string> = { question };
  const questions: Record<string, JevQuestion> = {};
  businesses.forEach((b, i) => {
    state[`business${i}`] = b.name;
    b.passages.forEach((p, j) => {
      state[`excerpt${i}_${j}`] = p.slice(0, 900);
      questions[`o${i}_${j}`] = {
        type: "noul",
        instructions: `Does \`excerpt${i}_${j}\` (from the website of \`business${i}\`) show that this business offers, sells, rents or does what \`question\` asks for? Answer no if it only mentions it, says the business does not do it, or is about something else.`,
      };
    });
  });
  const answers = await jevAsk(state, questions, 5000);
  if (!answers) return null;
  return businesses.map((b, i) => Math.max(0, ...b.passages.map((_, j) => {
    const a = answers[`o${i}_${j}`] as JevNoulAnswer | undefined;
    return a && typeof a.noul === "number" ? a.noul : 0;
  })));
}

/** Languages with fixed texts (the router names the visitor's language). */
export const OFFER_LANGS = ["pl", "en", "uk", "fr", "de", "other"] as const;
export type OfferLang = (typeof OFFER_LANGS)[number];


/** Split a reply into checkable statements (sentences and list items). */
// Sentence ends before a capital letter, but never after Polish abbreviations
// ("ul.", "pon.-pt.", "np.", "tel.") or inside times/prices. Newlines always end one.
export const SENTENCE_END = /(\n+)|(?<=(?<!(?:^|[\s(])(?:ul|al|pl|os|pon|pt|wt|śr|czw|sob|niedz|np|tj|tzw|nr|lok|tel|godz|in|dr|prof|mgr|ok|św|bud|ww|m|r|zł))[.!?])(\s+)(?=[A-ZĄĆĘŁŃÓŚŹŻÀ-ÖØ-ÞА-ЯЄІЇҐ])/;
const unlink = (t: string) => t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
const cleanStatement = (t: string) => t.replace(/^[\s*#>-]+|\*\*/g, "").trim();

export function splitStatements(reply: string): string[] {
  return unlink(reply)
    .split(SENTENCE_END)
    .filter((s, i) => i % 3 === 0 && s !== undefined)
    .map(cleanStatement)
    .filter((s) => s.length >= 12)
    .slice(0, 24);
}


/**
 * Answer verification: P(statement asserts a fact about the business that the
 * sources do not support) for every statement of a reply, in one call.
 */
export async function jevUnsupportedStatements(question: string, statements: string[], sources: string[], timeoutMs = 4000): Promise<number[] | null> {
  if (statements.length === 0) return [];
  const questions: Record<string, JevQuestion> = {};
  statements.forEach((_, i) => {
    questions[`s${i}`] = {
      type: "noul",
      instructions: `Does \`statements[${i}]\` state a fact about the business that the \`sources\` do not support or that they contradict?`,
      criteria: {
        true: "It states a specific fact (what we do or offer, where it happens, who does it, a price, time, number, address or contact) that is missing from the sources or differs from them.",
        false: "The sources support it (stated or directly implied; a total correctly calculated from prices in the sources and quantities in the question counts), or it is only a greeting, an offer to help, a general invitation to contact us, or a statement that some information is not available here.",
      },
    };
  });
  const answers = await jevAsk({ question, sources, statements }, questions, timeoutMs);
  if (!answers) return null;
  const out = statements.map((_, i) => (answers[`s${i}`] as JevNoulAnswer | undefined)?.noul);
  return out.every((v) => typeof v === "number") ? (out as number[]) : null;
}

/**
 * Jev's health from real traffic: the last 5 minutes of outcomes. Out of credits (402) or mostly failing
 * means the chat runs without its checks - the deep health check alerts on it (it once ran out of
 * credits unnoticed).
 */
const outcomes: { at: number; ok: boolean; status: number }[] = [];
let last402At = 0;
function jevOutcome(ok: boolean, status = 0): void {
  const now = Date.now();
  outcomes.push({ at: now, ok, status });
  if (status === 402) last402At = now;
  while (outcomes.length && (outcomes[0].at < now - 5 * 60_000 || outcomes.length > 2000)) outcomes.shift();
}
export function jevHealth(): { ok: boolean; calls: number; failed: number; outOfCredits: boolean; lastStatus: number | null } {
  const failed = outcomes.filter((o) => !o.ok).length;
  const outOfCredits = Date.now() - last402At < 10 * 60_000;
  const lastStatus = outcomes.length ? outcomes[outcomes.length - 1].status || (outcomes[outcomes.length - 1].ok ? 200 : 0) : null;
  return { ok: !outOfCredits && !(outcomes.length >= 5 && failed / outcomes.length > 0.5), calls: outcomes.length, failed, outOfCredits, lastStatus };
}
