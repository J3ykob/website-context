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
      return fetch(new Request(request, { headers }));
    }
    return new Response(`${url.hostname} is not reachable from this sandbox\n`, { status: 403 });
  }
}
