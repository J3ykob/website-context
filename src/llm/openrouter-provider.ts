import { countLlm, turnVariant } from "./turn-usage.js";
import { routingFor } from "./pin.js";

// OpenRouter routes each call to one of a model's providers; a provider that
// fails (404 "model not found", 429, 5xx, or a 400 the provider itself returned,
// e.g. "model deprecated") fails the call, though another would answer. Up to two
// retries, each routed away from every provider that failed recently (named in
// the error) and without the speed preference that picked them. Request errors
// (400 without a provider, 401, 402) are not retried - those won't change.
type ProviderPrefs = { sort?: string; ignore?: string[] };
// A provider that failed is skipped by every call for a while (Vertex kept
// answering 404 for hours; each call paid a failed attempt first).
const AVOID_MS = 10 * 60_000;
// Admin A/B (header x-test-variant: model:<openrouter id>): the reply model for this request.
const testModel = (): string => { const v = turnVariant(); return v.startsWith("model:") ? v.slice(6) : ""; };
// Chat replies are written without hidden reasoning: models that reason by default (claude-haiku-5.5)
// spent 170-230 of max_tokens on it, so replies stopped mid-sentence (finish_reason "length").
const REASONING = process.env.OPENROUTER_REASONING === "on" ? {} : { reasoning: { enabled: false } };
const avoided = new Map<string, number>();
function avoidList(): string[] {
  const now = Date.now();
  for (const [p, until] of avoided) if (until < now) avoided.delete(p);
  // At most the two most recent: skipping every provider would leave the model nowhere to run.
  return [...avoided.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([p]) => p);
}
// A provider that is far slower than the others (seen: 15.7 s for 80 tokens where the others took
// 2-6 s) is skipped for a while too - a visitor is waiting. Thresholds are generous on purpose.
const SLOW_MS = 5 * 60_000;
function noteSpeed(provider: string | undefined, ms: number, outTokens: number, firstTokenMs?: number): void {
  if (!provider || provider === "?") return;
  const slow = firstTokenMs !== undefined ? firstTokenMs > 5000 : outTokens < 300 && ms > 8000;
  if (!slow) return;
  avoided.set(provider, Math.max(avoided.get(provider) || 0, Date.now() + SLOW_MS));
  console.warn(`[openrouter] ${provider} slow (${(ms / 1000).toFixed(1)}s, ${firstTokenMs !== undefined ? `first token ${(firstTokenMs / 1000).toFixed(1)}s` : `${outTokens} tokens`}) - skipped for 5 min`);
}
async function withProviderRetry(call: (provider: ProviderPrefs) => Promise<Response>, model = ""): Promise<Response> {
  const skip = avoidList();
  // A fixed provider order per model (src/llm/pin.ts) - the same input gives the same output; sorting by
  // throughput rotated providers (and quantisations) on every call.
  const pinned = process.env.OPENROUTER_PROVIDER_SORT ? { sort: process.env.OPENROUTER_PROVIDER_SORT } : routingFor(model).provider;
  let r = await call({ ...pinned, ...(skip.length ? { ignore: skip } : {}) } as ProviderPrefs);
  for (let attempt = 0; attempt < 2 && !r.ok; attempt++) {
    const body = await r.clone().text().catch(() => "");
    let provider: string | undefined;
    try { provider = JSON.parse(body)?.error?.metadata?.provider_name; } catch {}
    if (![404, 408, 429, 500, 502, 503, 504].includes(r.status) && !(r.status === 400 && provider)) break;
    if (provider) avoided.set(provider, Date.now() + AVOID_MS);
    console.warn(`[openrouter] provider error ${r.status}${provider ? ` (${provider})` : ""}, retrying elsewhere`);
    const ignore = avoidList();
    r = await call(ignore.length ? { ignore } : {});
  }
  return r;
}

export interface OpenRouterConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  siteUrl?: string;
  siteName?: string;
}

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class OpenRouterProvider {
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private siteUrl: string;
  private siteName: string;

  constructor(config: OpenRouterConfig = {}) {
    this.apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || "";
    this.model = config.model || process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-5.5"; // the production model (render.yaml); qwen until 2026-10-29
    this.maxTokens = config.maxTokens || 1024;
    // 0.3 since 2026-10-25: at 0.7 the replies had typos, garbled words and small invented details.
    // 0: the same conversation gets the same reply (0.3 was tuned on qwen for typos - STALE; docs/limits.md).
    this.temperature = config.temperature ?? (process.env.OPENROUTER_TEMPERATURE !== undefined ? Number(process.env.OPENROUTER_TEMPERATURE) : 0);
    this.siteUrl = config.siteUrl || process.env.SITE_URL || "";
    this.siteName = config.siteName || "website-context";
  }

  async chat(messages: OpenRouterMessage[], overrides?: { model?: string; maxTokens?: number; temperature?: number }): Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number } }> {
    // A stalled provider must not hang the caller (and the visitor's chat) forever:
    // abort after OPENROUTER_TIMEOUT_MS (default 60 s). Covers the whole response.
    const t0 = Date.now();
    const response = await withProviderRetry((provider) => fetch("https://openrouter.ai/api/v1/chat/completions", {
      signal: AbortSignal.timeout(Number(process.env.OPENROUTER_TIMEOUT_MS) || 60000),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + this.apiKey,
        "HTTP-Referer": this.siteUrl,
        "X-Title": this.siteName,
      },
      body: JSON.stringify({
        model: overrides?.model || testModel() || this.model,
        messages,
        max_tokens: overrides?.maxTokens ?? this.maxTokens,
        ...REASONING,
        temperature: overrides?.temperature ?? this.temperature,
        usage: { include: true }, // the call's cost in USD (spend caps, src/security/budget.ts)
        provider,
        ...(routingFor(overrides?.model || testModel() || this.model).seed !== undefined ? { seed: routingFor(overrides?.model || testModel() || this.model).seed } : {}),
      }),
    }), overrides?.model || testModel() || this.model);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error("OpenRouter request failed (" + response.status + "): " + errorText);
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; completion_tokens: number; cost?: number };
      provider?: string;
    };

    countLlm(data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0, t0, `${data.provider || "?"} out=${data.usage?.completion_tokens || 0}`, Number(data.usage?.cost) || 0);
    noteSpeed(data.provider, Date.now() - t0, data.usage?.completion_tokens || 0);
    return {
      content: data.choices[0]?.message?.content || "",
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0 },
    };
  }

  // Streaming variant — calls onToken(delta) as tokens arrive, returns the full text.
  // Lets the chat surface a response token-by-token (first token ~1s vs ~3.5s full).
  async chatStream(messages: OpenRouterMessage[], onToken: (delta: string) => void, maxTokens?: number): Promise<{ content: string }> {
    const t0 = Date.now();
    let first = 0;
    let servedBy = "?";
    const response = await withProviderRetry((provider) => fetch("https://openrouter.ai/api/v1/chat/completions", {
      signal: AbortSignal.timeout(Number(process.env.OPENROUTER_STREAM_TIMEOUT_MS) || 120000),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + this.apiKey,
        "HTTP-Referer": this.siteUrl,
        "X-Title": this.siteName,
      },
      body: JSON.stringify({
        model: testModel() || this.model,
        messages,
        max_tokens: maxTokens || this.maxTokens,
        temperature: this.temperature,
        stream: true,
        provider,
        usage: { include: true },
        ...REASONING,
      }),
    }), testModel() || this.model);

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => "");
      throw new Error("OpenRouter request failed (" + response.status + "): " + errorText);
    }

    const reader = (response.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null = null;
    while (true) {
      const { done, value } = await reader.read();
      // The last line may come without a newline (Anthropic models' streams): read it too, or the reply's end is lost.
      buffer += done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep the (possibly incomplete) last line
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue; // skip SSE comments / keepalives
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (json.provider) servedBy = json.provider;
          if (json.usage) usage = json.usage;
          if (delta) { if (!first) first = Date.now() - t0; content += delta; onToken(delta); }
        } catch { /* partial JSON across chunks — ignored, completes next read */ }
      }
      if (done) break;
    }
    countLlm(usage?.prompt_tokens || 0, usage?.completion_tokens || 0, t0, `stream ${servedBy} first=${(first / 1000).toFixed(1)}s chars=${content.length}`, Number(usage?.cost) || 0);
    if (first) noteSpeed(servedBy, Date.now() - t0, 0, first);
    return { content };
  }
}
