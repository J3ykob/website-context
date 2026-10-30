import type { PiiMasker } from "./masker";
import type { Reranker } from "./reranker";
import type { ProjectAgent } from "./agent";

export interface Env {
  AGENT: DurableObjectNamespace<ProjectAgent>;
  MASKER: DurableObjectNamespace<PiiMasker>;
  RERANKER: DurableObjectNamespace<Reranker>;
  RUNNER_SECRET: string;
  OPENROUTER_API_KEY: string;
}
