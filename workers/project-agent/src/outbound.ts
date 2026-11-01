import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "./env";

// Every HTTP(S) request from the agent's sandbox lands here (Internet access is off). Only the model
// API is reachable; the OpenRouter key is added here, so it never enters the sandbox.
export class Outbound extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return new Response("HTTPS only\n", { status: 403 });
    if (url.hostname === "openrouter.ai" && url.pathname.startsWith("/api/v1/")) {
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${this.env.OPENROUTER_API_KEY}`);
      headers.set("x-title", "Whisp project agent");
      // Reasoning off on every model call (opencode does not pass the model's options through): a step spent its
      // whole 32k output on reasoning and the run wrote nothing (W2, 2026-11-01, 1 in 3-4 runs).
      if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = (await request.json().catch(() => null)) as Record<string, any> | null;
        if (body) {
          // A budget (max_tokens) was only a hint: steps still spent 32k on reasoning. Off: the agent's steps
          // read files, compute in scripts and write - the reasoning ran away instead of acting.
          body.reasoning = { enabled: false };
          // The fixed provider the agent's config asks for (fp8 weights, same provider every step) - also not passed through.
          if (String(body.model || "").startsWith("deepseek/") && !body.provider) body.provider = { order: ["deepinfra", "novita", "nebius"], quantizations: ["fp8"], allow_fallbacks: true };
          headers.delete("content-length");
          return fetch(url.toString(), { method: "POST", headers, body: JSON.stringify(body) });
        }
      }
      return fetch(new Request(request, { headers }));
    }
    return new Response(`${url.hostname} is not reachable from this sandbox\n`, { status: 403 });
  }
}
