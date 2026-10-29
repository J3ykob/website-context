/**
 * What answering one chat message cost: LLM and Jev calls and tokens, counted by
 * the providers into the store of the running request (AsyncLocalStorage, so
 * concurrent requests don't mix). The server runs each /api/chat request inside
 * turnUsage.run() and reports it to admins (routing evals, cost checks).
 * Background work that outlives the request (the project agent) is not counted
 * here - it records its own usage in the project.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface TurnUsage { exempt?: boolean; usd?: number; ip?: string; tenantId?: string; sessionKey?: string; cheap?: boolean; llmCalls: number; llmIn: number; llmOut: number; jevCalls: number; jevIn: number; at: number; steps: string[]; noJev?: boolean; variant?: string; debug?: Record<string, unknown> }
export const turnUsage = new AsyncLocalStorage<TurnUsage>();
export const newTurnUsage = (): Omit<TurnUsage, "at"> & { at: number } => ({ llmCalls: 0, llmIn: 0, llmOut: 0, jevCalls: 0, jevIn: 0, at: Date.now(), steps: [] });

const sec = (ms: number) => (ms / 1000).toFixed(1);
/** One LLM call; `started` (Date.now() before the request) adds it to the turn's timeline. */
export function countLlm(inTok = 0, outTok = 0, started?: number, detail = "", usd = 0): void {
  const u = turnUsage.getStore();
  if (!u) return;
  u.llmCalls++; u.llmIn += inTok; u.llmOut += outTok; u.usd = (u.usd || 0) + usd;
  if (started) u.steps.push(`llm @${sec(started - u.at)}s ${sec(Date.now() - started)}s${detail ? ` ${detail}` : ""}`);
}
/** Admin test of the no-Jev safe mode (header x-test-no-jev): Jev counts as unavailable for this request. */
/** Admin trace detail for this turn (what was selected, why a reply was blocked) - for evals. */
export function noteTurn(key: string, value: unknown): void {
  const u = turnUsage.getStore();
  if (u) (u.debug ||= {})[key] = value;
}
/** Admin A/B test (header x-test-variant): the variant this request runs. */
export const turnVariant = (): string => turnUsage.getStore()?.variant || "";
export const jevOffForTurn = (): boolean => !!turnUsage.getStore()?.noJev;


export function countJev(inTok = 0, started?: number): void {
  const u = turnUsage.getStore();
  if (!u) return;
  u.jevCalls++; u.jevIn += inTok;
  if (started) u.steps.push(`jev @${sec(started - u.at)}s ${sec(Date.now() - started)}s`);
}
/** Jev calls made so far in this turn (the per-turn cap in jev.ts). */
export const jevTurnCount = (): number => turnUsage.getStore()?.jevCalls || 0;
export function noteJevCapped(): void { const u = turnUsage.getStore(); if (u) (u.debug ||= {}).jevCapped = true; }
/** The turn runs over a spend cap: no network search, no project agent (src/security/budget.ts). */
export const turnCheap = (): boolean => !!turnUsage.getStore()?.cheap;
/** Who is asking (set by the server for /api/chat): the IP for per-IP quotas. */
export const turnIp = (): string => turnUsage.getStore()?.ip || "";
/** Admin demo pass or our own IP: quotas and spend caps don't apply (demos must never hit them). */
export const turnExempt = (): boolean => !!turnUsage.getStore()?.exempt;
