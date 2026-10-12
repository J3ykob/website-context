import { SandboxFileError, SandboxProtocolError } from "@cloudflare/sandbox";

import type { RunRequest } from "./agent";
import type { Env } from "./env";

export { ProjectAgent } from "./agent";
export { PiiMasker } from "./masker";
export { Outbound } from "./outbound";

// Called only by the Render server (bearer RUNNER_SECRET):
//   POST   /projects/:id/run   start a run (RunRequest without projectId) -> 202 {runId} | 409 busy
//   GET    /projects/:id/run   {state: none | running | done (with the unmasked result)}
//   DELETE /projects/:id/run   stop and forget (mapping, result, sandbox)
//   GET    /health
const MAX_PROMPT_BYTES = 100 * 1024; // one argv entry; Linux rejects 128 KiB or more
const MAX_FILES = 200;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (!authorized(request, env.RUNNER_SECRET)) return new Response("Unauthorized", { status: 401 });

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3 || parts[0] !== "projects" || parts[2] !== "run") return new Response("Not found", { status: 404 });
    const projectId = decodeURIComponent(parts[1]);
    if (!projectId || projectId.length > 120) return new Response("Bad project id", { status: 400 });
    const name = await sandboxName(projectId);
    const agent = env.AGENT.getByName(name);

    try {
      if (request.method === "POST") {
        const body = (await request.json().catch(() => null)) as Partial<RunRequest> | null;
        const problem = validate(body);
        if (problem) return new Response(problem, { status: 400 });
        const r = await agent.start(name, { ...(body as RunRequest), projectId });
        return r.state === "busy" ? new Response("A run is already in progress", { status: 409 }) : Response.json(r, { status: 202 });
      }
      if (request.method === "GET") return Response.json(await agent.status());
      if (request.method === "DELETE") {
        await agent.cancel();
        return new Response(null, { status: 204 });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (cause) {
      console.error({ event: "project-agent.failed", projectId, method: request.method, error: cause instanceof Error ? cause.stack : String(cause) });
      const msg = SandboxFileError.is(cause) ? "Sandbox file operation failed" : SandboxProtocolError.is(cause) ? "Sandbox protocol failed" : "Run failed";
      return new Response(`${msg}: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 500), { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

function validate(b: Partial<RunRequest> | null): string | null {
  if (!b || typeof b !== "object") return "JSON body required";
  if (typeof b.prompt !== "string" || !b.prompt.trim()) return "prompt required";
  if (new TextEncoder().encode(b.prompt).byteLength > MAX_PROMPT_BYTES) return "prompt too long";
  if (typeof b.rules !== "string") return "rules required";
  if (!b.model || typeof b.model.id !== "string" || !b.model.cost) return "model {id, cost} required";
  const files = b.files ?? {};
  const pub = b.publicFiles ?? {};
  if (typeof files !== "object" || typeof pub !== "object") return "files must be objects";
  const entries = [...Object.entries(files), ...Object.entries(pub)];
  if (entries.length > MAX_FILES) return "too many files";
  let total = 0;
  for (const [p, t] of entries) {
    if (typeof t !== "string") return `file ${p} must be text`;
    total += t.length;
  }
  if (total > MAX_INPUT_BYTES) return "files too large";
  return null;
}

// Durable Object (and sandbox) name per project: a hash of its id (ids are mixed-case base64url).
async function sandboxName(projectId: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(projectId)));
  return `p-${Array.from(d.subarray(0, 20), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function authorized(request: Request, secret: string): boolean {
  const h = request.headers.get("authorization") ?? "";
  const given = new TextEncoder().encode(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = new TextEncoder().encode(secret ?? "");
  if (!want.length || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given[i] ^ want[i];
  return diff === 0;
}
