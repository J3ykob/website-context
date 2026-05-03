import type { EmbeddingProvider } from "./types.js";

export interface BGEProviderConfig {
  host?: string;
  port?: number;
  batchSize?: number;
  model?: "bge-large-en-v1.5" | "bge-m3";
}

export class BGEEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string;
  private batchSize: number;
  readonly dimensions: number;
  readonly modelName: string;

  constructor(config: BGEProviderConfig = {}) {
    const host = config.host || process.env.BGE_HOST || "176.9.1.133";
    const port = config.port || parseInt(process.env.BGE_PORT || "7900");
    this.baseUrl = `http://${host}:${port}`;
    this.batchSize = config.batchSize || 256;
    this.modelName = config.model || "bge-large-en-v1.5";
    this.dimensions = this.modelName === "bge-m3" ? 1024 : 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);

      const response = await fetch(`${this.baseUrl}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: batch }),
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
