/**
 * Plan, then write (A/B variant "plan"). The reply model first QUOTES what our pages say about each
 * thing the customer asks (or finds nothing), code keeps only quotes that are word for word on our
 * pages, Jev keeps only quotes that answer their point; the writer then gets this short plan instead
 * of the pages, so a gap is stated as a gap instead of being filled with what businesses usually say
 * (2026-10-25 traces: 85% of drafts with partial information were blocked, mostly for such fillers).
 */
import { jevAsk, type JevNoulAnswer } from "./jev.js";

export interface PlanPoint { ask: string; quotes: string[] }
export interface Plan { points: PlanPoint[]; advice: boolean; dropped: number }

export function planPrompt(brand: string, facts: string): string {
  return `You prepare the facts for the next reply of ${brand}'s website chat. You do not write the reply.

## Our pages
${facts}

## Task
Read the conversation. List each thing the customer's LATEST message asks (a follow-up refers to what was discussed before). For each, copy word for word the sentences from "Our pages" that state the answer or part of it - exact text, unchanged, in the original language - or give no quotes if our pages don't state it. Also say whether the customer asks for advice (what to choose, how to do something).

Reply with JSON only: {"points":[{"ask":"what the customer asks, briefly","quotes":["exact sentence", "..."]}],"advice":true}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[„”“"«»*]/g, "").replace(/\s+/g, " ").trim();

/** The model's plan with every quote checked against the pages: a quote that is not word for word there is dropped. */
export function parsePlan(raw: string, facts: string): Plan | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(j?.points)) return null;
  const hay = norm(facts);
  let dropped = 0;
  const points: PlanPoint[] = j.points.slice(0, 6).map((p: any) => {
    const quotes = (Array.isArray(p?.quotes) ? p.quotes : []).map((q: unknown) => String(q || "").trim()).filter(Boolean).filter((q: string) => {
      // A quote may skip a part with "…": every piece must be on the page.
      const pieces = q.split(/…|\.\.\./).map(norm).filter((x) => x.length >= 8);
      const ok = pieces.length > 0 && pieces.every((x) => hay.includes(x));
      if (!ok) dropped++;
      return ok;
    });
    return { ask: String(p?.ask || "").slice(0, 200), quotes: quotes.slice(0, 4) };
  }).filter((p: PlanPoint) => p.ask);
  return { points, advice: !!j.advice, dropped };
}

/** Jev: does each quote actually answer its point? (A real but unrelated sentence is not an answer.) */
export async function keepAnswering(plan: Plan): Promise<Plan> {
  const pairs = plan.points.flatMap((p, i) => p.quotes.map((q, k) => ({ i, k, ask: p.ask, q }))).slice(0, 20);
  if (!pairs.length) return plan;
  const state: Record<string, string> = {};
  const questions: Record<string, any> = {};
  pairs.forEach((x, n) => {
    state[`ask${n}`] = x.ask; state[`quote${n}`] = x.q.slice(0, 1200);
    questions[`q${n}`] = { type: "noul", instructions: `Does \`quote${n}\` state the answer, or part of the answer, to \`ask${n}\` (a question to the business)?` };
  });
  const a = await jevAsk(state, questions, 5000).catch(() => null);
  if (!a) return plan;
  const keep = new Set(pairs.filter((_, n) => ((a[`q${n}`] as JevNoulAnswer | undefined)?.noul ?? 1) >= 0.5).map((x) => `${x.i}:${x.k}`));
  return { ...plan, points: plan.points.map((p, i) => ({ ...p, quotes: p.quotes.filter((_, k) => keep.has(`${i}:${k}`)) })) };
}

export function renderPlan(plan: Plan): string {
  return plan.points.map((p, i) => `${i + 1}. The customer asks: ${p.ask}\n${p.quotes.length ? p.quotes.map((q) => `   Our pages say: "${q}"`).join("\n") : "   Our pages don't state this."}`).join("\n");
}
