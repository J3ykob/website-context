export interface VLLMConfig {
  baseUrl: string; // e.g., "http://176.9.1.133:7902"
  model?: string; // e.g., "Qwen/Qwen2.5-7B-Instruct"
  maxTokens?: number;
  temperature?: number;
}

export interface VLLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface VLLMResponse {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class VLLMProvider {
  private baseUrl: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: VLLMConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.model = config.model || "default";
    this.maxTokens = config.maxTokens || 1024;
    this.temperature = config.temperature || 0.7;
  }

  async chat(messages: VLLMMessage[]): Promise<VLLMResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`vLLM request failed (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      content: data.choices[0]?.message?.content || "",
      usage: data.usage,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
