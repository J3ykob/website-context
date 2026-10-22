/**
 * What answering one chat message cost: LLM and Jev calls and tokens, counted by
 * the providers into the store of the running request (AsyncLocalStorage, so
 * concurrent requests don't mix). The server runs each /api/chat request inside
 * turnUsage.run() and reports it to admins (routing evals, cost checks).
 * Background work that outlives the request (the project agent) is not counted
 * here - it records its own usage in the project.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface TurnUsage { llmCalls: number; llmIn: number; llmOut: number; jevCalls: number; jevIn: number }
export const turnUsage = new AsyncLocalStorage<TurnUsage>();
export const newTurnUsage = (): TurnUsage => ({ llmCalls: 0, llmIn: 0, llmOut: 0, jevCalls: 0, jevIn: 0 });

export function countLlm(inTok = 0, outTok = 0): void {
  const u = turnUsage.getStore();
  if (u) { u.llmCalls++; u.llmIn += inTok; u.llmOut += outTok; }
}
export function countJev(inTok = 0): void {
  const u = turnUsage.getStore();
  if (u) { u.jevCalls++; u.jevIn += inTok; }
}
