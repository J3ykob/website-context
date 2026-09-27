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

// "model" in the request body picks the embedding space. Default stays the
// English bge-large (the whisp-vectors index); "bge-m3" is multilingual (Polish,
// Ukrainian, ...) and feeds the whisp-vectors-m3 index. Both are 1024-d.
const MODELS: Record<string, { id: string; options: Record<string, unknown> }> = {
  "bge-large-en-v1.5": { id: "@cf/baai/bge-large-en-v1.5", options: { pooling: "cls" } },
  "bge-m3": { id: "@cf/baai/bge-m3", options: {} },
};
const DEFAULT_MODEL = "bge-large-en-v1.5";
const MODEL = MODELS[DEFAULT_MODEL].id;
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
      return json({ ok: true, model: MODEL, models: Object.keys(MODELS), dimensions: DIMENSIONS });
    }

    if (request.method !== "POST" || url.pathname !== "/embed") {
      return json({ error: "not found" }, 404);
    }

    if (env.BGE_API_KEY && request.headers.get("X-API-Key") !== env.BGE_API_KEY) {
      return json({ error: "unauthorized" }, 401);
    }

    let texts: unknown;
    let modelName: unknown;
    try {
      ({ texts, model: modelName } = (await request.json()) as { texts?: unknown; model?: unknown });
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!Array.isArray(texts) || texts.length === 0 || !texts.every((t) => typeof t === "string")) {
      return json({ error: "body must be {\"texts\": [string, ...]}" }, 400);
    }

    const name = typeof modelName === "string" && modelName ? modelName : DEFAULT_MODEL;
    const model = MODELS[name];
    if (!model) return json({ error: `unknown model "${name}"`, models: Object.keys(MODELS) }, 400);

    const embeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += AI_BATCH) {
      const batch = texts.slice(i, i + AI_BATCH) as string[];
      let result: { data?: number[][] };
      try {
        const raw = (await env.AI.run(model.id as any, { text: batch, ...model.options } as any)) as { data?: number[][]; response?: number[][] };
        result = { data: raw?.data || raw?.response };
      } catch (e: any) {
        // Surface the real Workers AI error (quota, rate limit, model issue)
        // instead of a bare 1101 so the caller/logs can see it.
        return json({ error: "workers_ai_failed", detail: String(e?.message || e).slice(0, 300) }, 502);
      }
      if (!result?.data || result.data.length !== batch.length) {
        return json({ error: "Workers AI returned unexpected embedding count" }, 502);
      }
      for (const vec of result.data) embeddings.push(l2Normalize(vec));
    }

    return json({ embeddings, dimensions: DIMENSIONS, model: name });
  },
};
