/**
 * Repeatable model calls (2026-10-30): the same input should give the same output. OpenRouter rotated
 * each call to the fastest provider - for deepseek-v4.1-flash that is ~40 providers running different
 * quantisations (fp4, mxfp4, fp8), i.e. effectively different models; the chain test swung +-3 of 20
 * cases between identical runs. Decisions and the agent now go to a fixed provider order (fallbacks only
 * when it is down), at temperature 0 with a fixed seed where supported. docs/limits.md.
 */
export interface Routing { provider: Record<string, unknown>; seed?: number }

export function routingFor(model: string): Routing {
  if (model.startsWith("anthropic/")) return { provider: { order: ["anthropic", "amazon-bedrock", "google-vertex"], allow_fallbacks: true } };
  if (model.startsWith("deepseek/")) return { provider: { order: ["deepinfra", "novita", "nebius"], quantizations: ["fp8"], allow_fallbacks: true }, seed: 7 };
  if (model.startsWith("qwen/")) return { provider: { order: ["deepinfra", "parasail"], quantizations: ["fp8"], allow_fallbacks: true }, seed: 7 };
  return { provider: { sort: "throughput" } };
}
