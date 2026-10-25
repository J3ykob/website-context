/**
 * Plan, then write (A/B variant "plan"). The reply model first cites, by number, the sentences of our
 * pages that answer each thing the customer asks (or none); code takes those exact sentences. The
 * writer then gets this short plan instead of the pages, so a gap is stated as a gap instead of being filled with what businesses usually say
 * (2026-10-25 traces: 85% of drafts with partial information were blocked, mostly for such fillers).
 */
export interface PlanPoint { ask: string; quotes: string[] }
export interface Plan { points: PlanPoint[]; advice: boolean; dropped: number }

/** Our pages as numbered sentences: the plan cites numbers, code takes the exact sentences (nothing to copy, nothing to alter). */
export function numberSentences(facts: string, split: RegExp): string[] {
  return facts.split(/\n+/).flatMap((line) => line.split(split).filter((_, i) => i % 3 === 0 && _ !== undefined)).map((x) => x.trim()).filter((x) => x.length >= 3);
}

export function planPrompt(brand: string, sentences: string[]): string {
  return `You prepare the facts for the next reply of ${brand}'s website chat. You do not write the reply.

## Our pages (numbered sentences)
${sentences.map((x, i) => `[${i + 1}] ${x}`).join("\n")}

## Task
Read the conversation. List each thing the customer's LATEST message asks (a follow-up refers to what was discussed before). For each, give the numbers of the sentences above that state the answer or part of it - or no numbers if our pages don't state it. Also say whether the customer asks for advice (what to choose, how to do something).

Reply with JSON only: {"points":[{"ask":"what the customer asks, briefly","ids":[3,17]}],"advice":false}`;
}

/** The model's plan: cited numbers become the exact sentences; unknown numbers are dropped. */
export function parsePlan(raw: string, sentences: string[]): Plan | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(j?.points)) return null;
  let dropped = 0;
  const points: PlanPoint[] = j.points.slice(0, 6).map((p: any) => {
    const ids = (Array.isArray(p?.ids) ? p.ids : []).map((x: unknown) => Number(x)).filter((n: number) => { const ok = Number.isInteger(n) && n >= 1 && n <= sentences.length; if (!ok) dropped++; return ok; });
    return { ask: String(p?.ask || "").slice(0, 200), quotes: [...new Set<number>(ids)].slice(0, 6).map((n) => sentences[n - 1]) };
  }).filter((p: PlanPoint) => p.ask);
  return { points, advice: !!j.advice, dropped };
}

export function renderPlan(plan: Plan): string {
  return plan.points.map((p, i) => `${i + 1}. The customer asks: ${p.ask}\n${p.quotes.length ? p.quotes.map((q) => `   Our pages say: "${q}"`).join("\n") : "   Our pages don't state this."}`).join("\n");
}
