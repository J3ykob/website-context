/**
 * BGE embedding shim on Workers AI - drop-in replacement for the self-hosted
 * GPU embed server (same contract: POST /embed {"texts": [...]} ->
 * {"embeddings": [...], "dimensions": 1024}).
 *
 * Runs @cf/baai/bge-large-en-v1.5 with pooling "cls" + L2 normalization so
 * query vectors land in the same embedding space as the existing
 * whisp-vectors index (built with FlagEmbedding CLS-pooled, normalized
 * embeddings). Workers AI's legacy mean pooling is NOT compatible.
 *
 * Auth: if the BGE_API_KEY secret is set, requests must send it as X-API-Key.
 */

export interface Env {
  AI: Ai;
  BGE_API_KEY?: string;
}

const MODEL = "@cf/baai/bge-large-en-v1.5";
const DIMENSIONS = 1024;
// Workers AI caps batch size per inference call.
const AI_BATCH = 100;

function l2Normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!norm) return v;
  return v.map((x) => x / norm);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return json({ ok: true, model: MODEL, dimensions: DIMENSIONS });
    }

    if (request.method !== "POST" || url.pathname !== "/embed") {
      return json({ error: "not found" }, 404);
    }

    if (env.BGE_API_KEY && request.headers.get("X-API-Key") !== env.BGE_API_KEY) {
      return json({ error: "unauthorized" }, 401);
    }

    let texts: unknown;
    try {
      ({ texts } = (await request.json()) as { texts?: unknown });
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!Array.isArray(texts) || texts.length === 0 || !texts.every((t) => typeof t === "string")) {
      return json({ error: "body must be {\"texts\": [string, ...]}" }, 400);
    }

    const embeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += AI_BATCH) {
      const batch = texts.slice(i, i + AI_BATCH) as string[];
      const result = (await env.AI.run(MODEL, { text: batch, pooling: "cls" })) as {
        data?: number[][];
      };
      if (!result?.data || result.data.length !== batch.length) {
        return json({ error: "Workers AI returned unexpected embedding count" }, 502);
      }
      for (const vec of result.data) embeddings.push(l2Normalize(vec));
    }

    return json({ embeddings, dimensions: DIMENSIONS, model: "bge-large-en-v1.5" });
  },
};
