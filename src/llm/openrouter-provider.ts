import { countLlm } from "./turn-usage.js";

// OpenRouter routes each call to one of a model's providers; a provider that
// fails (404 "model not found", 429, 5xx) fails the call, though another would
// answer. One retry lets OpenRouter route again. Not for request errors (400,
// 401, 402 - those won't change).
async function withProviderRetry(call: () => Promise<Response>): Promise<Response> {
  const r = await call();
  if (r.ok || ![404, 408, 429, 500, 502, 503, 504].includes(r.status)) return r;
  console.warn(`[openrouter] provider error ${r.status}, retrying once`);
  await r.text().catch(() => "");
  await new Promise((s) => setTimeout(s, 400));
  return call();
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
    const response = await withProviderRetry(() => fetch("https://openrouter.ai/api/v1/chat/completions", {
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
        provider: { sort: process.env.OPENROUTER_PROVIDER_SORT || "throughput" },
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
    const response = await withProviderRetry(() => fetch("https://openrouter.ai/api/v1/chat/completions", {
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
        provider: { sort: process.env.OPENROUTER_PROVIDER_SORT || "throughput" },
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
