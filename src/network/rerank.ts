/**
 * The network's "does this business offer what the customer needs?" decision, made by our own model:
 * bge-reranker-v2-m3 (int8 ONNX) in a container next to the project agent (workers/project-agent,
 * POST /rerank). Deterministic - the same pair always gets the same score (Jev differed on every call:
 * 1 of 57 repeat runs identical, 8 decisions flipped; the reranker 57/57 identical, top-1 52/57 vs Jev 50/57,
 * fleet test 2026-10-30). null when unreachable: the caller falls back to Jev.
 */
export const RERANK_MIN = () => Number(process.env.RERANK_MIN) || 0.05; // fitted on the fleet test: source 52/57 kept, 25/627 others

export async function rerankBusinesses(need: string, businesses: { passages: string[] }[]): Promise<number[] | null> {
  const url = process.env.PROJECT_AGENT_URL, secret = process.env.PROJECT_AGENT_SECRET;
  // Off by default until it beats Jev on the repeated network cases (owner, 2026-10-30): NETWORK_JUDGE=rerank.
  if (!url || !secret || process.env.NETWORK_JUDGE !== "rerank") return null;
  const pairs: [string, string][] = [];
  const owner: number[] = [];
  businesses.forEach((b, i) => { for (const p of b.passages.filter((x) => x && x.trim()).slice(0, 5)) { pairs.push([need.slice(0, 1000), p.slice(0, 1500)]); owner.push(i); } });
  if (!pairs.length) return businesses.map(() => 0);
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/rerank`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ pairs }), signal: AbortSignal.timeout(Number(process.env.RERANK_TIMEOUT_MS) || 20_000) });
    const j = (await r.json()) as { scores?: number[] };
    if (!r.ok || !Array.isArray(j.scores) || j.scores.length !== pairs.length) return null;
    const best = businesses.map(() => 0);
    j.scores.forEach((s, k) => { best[owner[k]] = Math.max(best[owner[k]], s); });
    (await import("../llm/decision-log.js")).logDecision("rerank", "bge-reranker-v2-m3-int8", { need: need.slice(0, 1000), n: pairs.length }, best);
    return best;
  } catch (e) {
    console.warn(`[rerank] unavailable: ${(e as Error).message}`);
    return null;
  }
}
