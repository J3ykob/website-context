import OpenAI from "openai";
import type { EmbeddingProvider, EmbeddingConfig } from "./types.js";

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private model: string;
  private batchSize: number;
  readonly dimensions: number;
  readonly modelName: string;

  constructor(config: EmbeddingConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      baseURL: config.baseUrl,
    });
    this.model = config.model || "text-embedding-3-small";
    this.batchSize = config.batchSize || 100;
    this.dimensions = this.model === "text-embedding-3-large" ? 3072 : 1536;
    this.modelName = this.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
      });

      const batchEmbeddings = response.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);

      allEmbeddings.push(...batchEmbeddings);
    }

    return allEmbeddings;
  }
}
