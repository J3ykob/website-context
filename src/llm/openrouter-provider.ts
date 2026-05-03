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
    this.model = config.model || "deepseek/deepseek-chat-v3";
    this.maxTokens = config.maxTokens || 1024;
    this.temperature = config.temperature || 0.7;
    this.siteUrl = config.siteUrl || process.env.SITE_URL || "";
    this.siteName = config.siteName || "website-context";
  }

  async chat(messages: OpenRouterMessage[]): Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number } }> {
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
}
