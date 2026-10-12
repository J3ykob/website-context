import type { PiiMasker } from "./masker";
import type { ProjectAgent } from "./agent";

export interface Env {
  AGENT: DurableObjectNamespace<ProjectAgent>;
  MASKER: DurableObjectNamespace<PiiMasker>;
  RUNNER_SECRET: string;
  OPENROUTER_API_KEY: string;
}
