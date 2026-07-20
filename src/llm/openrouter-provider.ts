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
    this.model = config.model || process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";
    this.maxTokens = config.maxTokens || 1024;
    this.temperature = config.temperature || 0.7;
    this.siteUrl = config.siteUrl || process.env.SITE_URL || "";
    this.siteName = config.siteName || "website-context";
  }

  async chat(messages: OpenRouterMessage[], overrides?: { model?: string; maxTokens?: number; temperature?: number }): Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number } }> {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error("OpenRouter request failed (" + response.status + "): " + errorText);
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: data.choices[0]?.message?.content || "",
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0 },
    };
  }

  // Streaming variant — calls onToken(delta) as tokens arrive, returns the full text.
  // Lets the chat surface a response token-by-token (first token ~1s vs ~3.5s full).
  async chatStream(messages: OpenRouterMessage[], onToken: (delta: string) => void): Promise<{ content: string }> {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
      }),
    });

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
    return { content };
  }
}
