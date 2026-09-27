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

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export type JevQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> };

export interface JevChoiceAnswer { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevNoulAnswer { type: "noul"; noul: number }
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export function jevEnabled(): boolean {
  return !!process.env.JEV_API_KEY;
}

export async function jevAsk(state: unknown, questions: Record<string, JevQuestion>, timeoutMs?: number): Promise<Record<string, JevAnswer> | null> {
  const key = process.env.JEV_API_KEY;
  if (!key) return null;
  const t0 = Date.now();
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.JEV_MODEL || "jev-latest", state, questions }),
      signal: AbortSignal.timeout(timeoutMs ?? (Number(process.env.JEV_TIMEOUT_MS) || 2500)),
    });
    if (!r.ok) { console.warn(`[jev] HTTP ${r.status} after ${Date.now() - t0}ms`); return null; }
    const answers = ((await r.json()) as any)?.answers;
    return answers && typeof answers === "object" ? answers : null;
  } catch (e: any) {
    console.warn(`[jev] ${e?.name === "TimeoutError" ? "timeout" : e?.message || e} after ${Date.now() - t0}ms`);
    return null;
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
