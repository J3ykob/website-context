import type { EmbeddingProvider } from "./types.js";

export interface BGEProviderConfig {
  url?: string;
  host?: string;
  port?: number;
  batchSize?: number;
  model?: "bge-large-en-v1.5" | "bge-m3";
  apiKey?: string;
}

// Full-URL config (config.url / BGE_URL, e.g. an https:// Workers AI shim)
// takes precedence over host:port, which only supports plain http.
export function bgeBaseUrl(config: BGEProviderConfig = {}): string {
  const url = config.url || process.env.BGE_URL;
  if (url) return url.replace(/\/+$/, "");
  const host = config.host || process.env.BGE_HOST || "176.9.1.133";
  const port = config.port || parseInt(process.env.BGE_PORT || "7900");
  return `http://${host}:${port}`;
}

export class BGEEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string;
  private batchSize: number;
  private apiKey: string;
  readonly dimensions: number;
  readonly modelName: string;

  constructor(config: BGEProviderConfig = {}) {
    this.baseUrl = bgeBaseUrl(config);
    this.batchSize = config.batchSize || 256;
    this.apiKey = config.apiKey || process.env.BGE_API_KEY || "";
    this.modelName = config.model || "bge-large-en-v1.5";
    this.dimensions = this.modelName === "bge-m3" ? 1024 : 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) headers["X-API-Key"] = this.apiKey;

      const response = await fetch(`${this.baseUrl}/embed`, {
        method: "POST",
        headers,
        body: JSON.stringify({ texts: batch }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`BGE embedding failed: ${response.status} ${await response.text()}`);
      }

      const data = await response.json() as { embeddings: number[][] };
      allEmbeddings.push(...data.embeddings);
    }

    return allEmbeddings;
  }
}
