import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000;
const READY_TIMEOUT_MS = 90_000;

// The placeholder mapping, opaque to TypeScript (built and read by the masker).
export type VaultState = Record<string, Record<string, string | number | { canon: string; forms: string[] }>>;
export interface MaskRequest { texts: Record<string, string>; allow?: string[]; catalog?: string[]; state?: VaultState }
export interface MaskResult { texts: Record<string, string>; state: VaultState; found: number }
export interface UnmaskResult { texts: Record<string, string>; unknown: string[]; altered: string[] }

// The PII masker (bardsai/eu-pii-anonimization-multilang, int8 ONNX) in its own container, outside every
// agent sandbox: the agent has a shell and must never see the model or a placeholder mapping. The
// service is stateless; callers keep the mapping.
export class PiiMasker extends DurableObject<Env> {
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

  mask(req: MaskRequest): Promise<MaskResult> {
    return this.#call("/mask", req) as Promise<MaskResult>;
  }

  unmask(texts: Record<string, string>, state: VaultState): Promise<UnmaskResult> {
    return this.#call("/unmask", { texts, state }) as Promise<UnmaskResult>;
  }

  // Concurrent callers share one start; blockConcurrencyWhile would cap it at 30 s, and a cold start
  // (container + model load) can take longer.
  #ready: Promise<void> | null = null;

  async #call(path: string, body: unknown): Promise<unknown> {
    if (!this.#container.running) this.#ready = null;
    this.#ready ||= this.#ensureRunning().catch((e) => { this.#ready = null; throw e; });
    await this.#ready;
    const r = await this.#container.getTcpPort(PORT).fetch(`http://masker${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`masker ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }

  async #ensureRunning(): Promise<void> {
    if (!this.#container.running) {
      this.#container.start({ image: this.#container.images.masker, instance: "standard-1", enableInternet: false });
      await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    }
    // The model takes a few seconds to load after a start.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last = "";
    for (;;) {
      try {
        const r = await this.#container.getTcpPort(PORT).fetch("http://masker/health");
        if (r.ok) return;
        last = `health ${r.status}`;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      if (Date.now() > deadline) {
        const info = await this.#container.inspect().catch((e) => `inspect failed: ${e}`);
        throw new Error(`masker did not become ready (running=${this.#container.running}; last: ${last}; ${JSON.stringify(info).slice(0, 400)})`);
      }
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
}
