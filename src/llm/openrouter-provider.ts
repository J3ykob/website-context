import { countLlm } from "./turn-usage.js";

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
const avoided = new Map<string, number>();
function avoidList(): string[] {
  const now = Date.now();
  for (const [p, until] of avoided) if (until < now) avoided.delete(p);
  return [...avoided.keys()];
}
async function withProviderRetry(call: (provider: ProviderPrefs) => Promise<Response>): Promise<Response> {
  const skip = avoidList();
  let r = await call({ sort: process.env.OPENROUTER_PROVIDER_SORT || "throughput", ...(skip.length ? { ignore: skip } : {}) });
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
    this.model = config.model || process.env.OPENROUTER_MODEL || "qwen/qwen3-235b-a22b-2507";
    this.maxTokens = config.maxTokens || 1024;
    this.temperature = config.temperature || 0.7;
    this.siteUrl = config.siteUrl || process.env.SITE_URL || "";
    this.siteName = config.siteName || "website-context";
  }

  async chat(messages: OpenRouterMessage[], overrides?: { model?: string; maxTokens?: number; temperature?: number }): Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number } }> {
    // A stalled provider must not hang the caller (and the visitor's chat) forever:
    // abort after OPENROUTER_TIMEOUT_MS (default 60 s). Covers the whole response.
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
        model: overrides?.model || this.model,
        messages,
        max_tokens: overrides?.maxTokens ?? this.maxTokens,
        temperature: overrides?.temperature ?? this.temperature,
        // The fastest of the model's providers (a visitor is waiting); OPENROUTER_PROVIDER_SORT=price to change.
        provider,
      }),
    }));

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error("OpenRouter request failed (" + response.status + "): " + errorText);
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    countLlm(data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0);
    return {
      content: data.choices[0]?.message?.content || "",
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0 },
    };
  }

  // Streaming variant — calls onToken(delta) as tokens arrive, returns the full text.
  // Lets the chat surface a response token-by-token (first token ~1s vs ~3.5s full).
  async chatStream(messages: OpenRouterMessage[], onToken: (delta: string) => void): Promise<{ content: string }> {
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
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        stream: true,
        provider,
      }),
    }));

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => "");
      throw new Error("OpenRouter request failed (" + response.status + "): " + errorText);
    }

    const reader = (response.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
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
          if (delta) { content += delta; onToken(delta); }
        } catch { /* partial JSON across chunks — ignored, completes next read */ }
      }
    }
    countLlm();
    return { content };
  }
}
