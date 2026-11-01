import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "./env";

// Every HTTP(S) request from the agent's sandbox lands here (Internet access is off). Only the model
// API is reachable; the OpenRouter key is added here, so it never enters the sandbox.
const REASONING_PER_STEP = 8000;

export class Outbound extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return new Response("HTTPS only\n", { status: 403 });
    if (url.hostname === "openrouter.ai" && url.pathname.startsWith("/api/v1/")) {
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${this.env.OPENROUTER_API_KEY}`);
      headers.set("x-title", "Whisp project agent");
      // A reasoning budget on every model call: opencode does not pass the model's options through, and a step
      // once spent its whole 32k output on reasoning and wrote nothing (W2, 2026-11-01).
      if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = (await request.json().catch(() => null)) as Record<string, any> | null;
        if (body) {
          if (body.reasoning?.enabled !== false) body.reasoning = { ...(body.reasoning || {}), max_tokens: REASONING_PER_STEP };
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
