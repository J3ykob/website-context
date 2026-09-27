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

    // Workers AI caps a whole bge-m3 request at 60k tokens (all texts together),
    // so batches are cut by an estimated token budget, not only by count. Polish
    // runs ~3 chars/token; 2.5 keeps a safety margin. One oversized text is cut.
    const MAX_TOKENS = name === "bge-m3" ? 50000 : Infinity;
    const MAX_TEXT_CHARS = 60000;
    const est = (t: string) => Math.ceil(t.length / 2.5);
    const clean = (texts as string[]).map((t) => t.slice(0, MAX_TEXT_CHARS));
    const batches: string[][] = [];
    let cur: string[] = [], tok = 0;
    for (const t of clean) {
      if (cur.length && (cur.length >= AI_BATCH || tok + est(t) > MAX_TOKENS)) { batches.push(cur); cur = []; tok = 0; }
      cur.push(t); tok += est(t);
    }
    if (cur.length) batches.push(cur);

    // Token-dense text (numbers, symbols) can still exceed the cap: on a
    // context-limit error the batch is halved and retried; a single text is cut.
    const runBatch = async (batch: string[]): Promise<number[][]> => {
      try {
        const raw = (await env.AI.run(model.id as any, { text: batch, ...model.options } as any)) as { data?: number[][]; response?: number[][] };
        const data = raw?.data || raw?.response;
        if (!data || data.length !== batch.length) throw new Error("Workers AI returned unexpected embedding count");
        return data;
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (/3030|max context/i.test(msg)) {
          if (batch.length > 1) {
            const mid = Math.ceil(batch.length / 2);
            return [...(await runBatch(batch.slice(0, mid))), ...(await runBatch(batch.slice(mid)))];
          }
          if (batch[0].length > 1000) return runBatch([batch[0].slice(0, Math.floor(batch[0].length / 2))]);
        }
        throw e;
      }
    };

    const embeddings: number[][] = [];
    for (const batch of batches) {
      let data: number[][];
      try {
        data = await runBatch(batch);
      } catch (e: any) {
        // Surface the real Workers AI error (quota, rate limit, model issue)
        // instead of a bare 1101 so the caller/logs can see it.
        return json({ error: "workers_ai_failed", detail: String(e?.message || e).slice(0, 300) }, 502);
      }
      for (const vec of data) embeddings.push(l2Normalize(vec));
    }

    return json({ embeddings, dimensions: DIMENSIONS, model: name });
  },
};
