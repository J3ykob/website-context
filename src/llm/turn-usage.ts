/**
 * What answering one chat message cost: LLM and Jev calls and tokens, counted by
 * the providers into the store of the running request (AsyncLocalStorage, so
 * concurrent requests don't mix). The server runs each /api/chat request inside
 * turnUsage.run() and reports it to admins (routing evals, cost checks).
 * Background work that outlives the request (the project agent) is not counted
 * here - it records its own usage in the project.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface TurnUsage { llmCalls: number; llmIn: number; llmOut: number; jevCalls: number; jevIn: number; at: number; steps: string[]; noJev?: boolean; variant?: string }
export const turnUsage = new AsyncLocalStorage<TurnUsage>();
export const newTurnUsage = (): Omit<TurnUsage, "at"> & { at: number } => ({ llmCalls: 0, llmIn: 0, llmOut: 0, jevCalls: 0, jevIn: 0, at: Date.now(), steps: [] });

const sec = (ms: number) => (ms / 1000).toFixed(1);
/** One LLM call; `started` (Date.now() before the request) adds it to the turn's timeline. */
export function countLlm(inTok = 0, outTok = 0, started?: number, detail = ""): void {
  const u = turnUsage.getStore();
  if (!u) return;
  u.llmCalls++; u.llmIn += inTok; u.llmOut += outTok;
  if (started) u.steps.push(`llm @${sec(started - u.at)}s ${sec(Date.now() - started)}s${detail ? ` ${detail}` : ""}`);
}
/** Admin test of the no-Jev safe mode (header x-test-no-jev): Jev counts as unavailable for this request. */
export const jevOffForTurn = (): boolean => !!turnUsage.getStore()?.noJev;

/**
 * The reply pipeline: "packs" (dynamic context, every word model-written) for everyone since
 * 2026-10-25 after the blind A/B (+0.23 overall, -39% errors). CHAT_VARIANT=base rolls it back;
 * admins can force either per request (header x-test-variant) for comparisons.
 */
export const variantForTurn = (): string => turnUsage.getStore()?.variant || process.env.CHAT_VARIANT || "packs";

export function countJev(inTok = 0, started?: number): void {
  const u = turnUsage.getStore();
  if (!u) return;
  u.jevCalls++; u.jevIn += inTok;
  if (started) u.steps.push(`jev @${sec(started - u.at)}s ${sec(Date.now() - started)}s`);
}
