import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000;
const READY_TIMEOUT_MS = 90_000;


// The network's decision model (BAAI/bge-reranker-v2-m3, int8 ONNX) in its own container: does an
// offer match a need? Deterministic and stateless; called by the Render server (src/network/find.ts).
export class Reranker extends DurableObject<Env> {
  readonly #container: Container;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const c = ctx.container;
    if (c === undefined) throw new Error("Container attachment is unavailable");
    this.#container = c;
    // Each instance sets its own timeout (not inherited). Not under blockConcurrencyWhile: a stuck call
    // there resets the object.
    if (c.running) c.setInactivityTimeout(INACTIVITY_TIMEOUT_MS).catch(() => {});
  }

  async warm(): Promise<void> {
    if (!this.#container.running) this.#ready = null;
    this.#ready ||= this.#ensureRunning().catch((e) => { this.#ready = null; throw e; });
    await this.#ready;
  }

  /** P(text answers/offers what the query asks) per pair - deterministic (bge-reranker-v2-m3 int8). */
  score(pairs: [string, string][]): Promise<{ scores: number[] }> {
    return this.#call("/score", { pairs }) as Promise<{ scores: number[] }>;
  }

  // Concurrent callers share one start; blockConcurrencyWhile would cap it at 30 s, and a cold start
  // (container + model load) can take longer.
  #ready: Promise<void> | null = null;

  async #call(path: string, body: unknown): Promise<unknown> {
    if (!this.#container.running) this.#ready = null;
    this.#ready ||= this.#ensureRunning().catch((e) => { this.#ready = null; throw e; });
    await this.#ready;
    const r = await this.#container.getTcpPort(PORT).fetch(`http://reranker${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`reranker ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }

  async #ensureRunning(): Promise<void> {
    if (!this.#container.running) {
      this.#container.start({ image: this.#container.images.reranker, instance: "standard-4", enableInternet: false });
      await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    }
    // The model takes a few seconds to load after a start.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last = "";
    for (;;) {
      try {
        const r = await this.#container.getTcpPort(PORT).fetch("http://reranker/health");
        if (r.ok) return;
        last = `health ${r.status}`;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      if (Date.now() > deadline) {
        const info = await this.#container.inspect().catch((e) => `inspect failed: ${e}`);
        throw new Error(`reranker did not become ready (running=${this.#container.running}; last: ${last}; ${JSON.stringify(info).slice(0, 400)})`);
      }
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
}
