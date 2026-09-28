/**
 * POST /api/agent/step - one decision of a goal-driven ("agent") flow.
 * The widget sends a snapshot of the page; the goal comes ONLY from the
 * tenant's stored flow definition, so this endpoint cannot be used as a
 * general-purpose browsing agent. Rate-limited per IP.
 */
import type { Express, Request } from "express";
import { getFlow } from "../flows/flow-store.js";
import { jevEnabled } from "../llm/jev.js";
import { decideStep, type AgentSnapshot, type AgentHistoryItem } from "./step.js";

const hits = new Map<string, { n: number; t: number }>();
function rateOk(req: Request): boolean {
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || now - e.t > 60000) { hits.set(ip, { n: 1, t: now }); return true; }
  e.n++;
  return e.n <= 120;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 120000) hits.delete(k); }, 300000).unref?.();

const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

export function registerAgentRoutes(app: Express): void {
  // Admin: Jev latency as seen from this server (raw fetch, no hedging).
  app.get("/api/admin/jev-probe", async (req, res) => {
    const secret = process.env.ADMIN_SECRET;
    if (!secret || req.query.secret !== secret) { res.status(403).json({ error: "Forbidden" }); return; }
    const n = Math.min(Number(req.query.n) || 10, 30);
    const body = JSON.stringify({ model: process.env.JEV_MODEL || "jev-latest", state: { page: "Wybierz placówkę i termin badania. ".repeat(110) }, questions: { a: { type: "noul", instructions: "Is this a date page?" } } });
    const out: (number | string)[] = [];
    for (let k = 0; k < n; k++) {
      const t = Date.now();
      try {
        const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${process.env.JEV_API_KEY}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(15000) });
        await r.text();
        out.push(r.ok ? Date.now() - t : `HTTP ${r.status} ${Date.now() - t}`);
      } catch (e: any) { out.push(`${e?.name || "error"} ${Date.now() - t}`); }
    }
    res.json({ ms: out });
  });

  app.post("/api/agent/step", async (req, res) => {
    if (!rateOk(req)) { res.status(429).json({ error: "Too many requests" }); return; }
    if (!jevEnabled()) { res.status(503).json({ error: "Agent unavailable" }); return; }
    const b = req.body || {};
    const tenantId = str(b.tenantId, 120), flowId = str(b.flowId, 120);
    if (!tenantId || !flowId) { res.status(400).json({ error: "tenantId and flowId required" }); return; }
    const flow = await getFlow(tenantId, flowId).catch(() => null);
    if (!flow || flow.status !== "active" || flow.executionMode !== "agent") { res.status(404).json({ error: "Flow not found" }); return; }

    const s = b.snapshot || {};
    const elements = Array.isArray(s.elements) ? s.elements.slice(0, 200).map((e: any) => ({
      i: Number(e.i), role: str(e.role, 20), label: str(e.label, 200),
      ops: (Array.isArray(e.ops) ? e.ops : []).filter((o: unknown) => o === "CLICK" || o === "TYPE" || o === "SELECT"),
      value: e.value === undefined ? undefined : str(e.value, 200),
      checked: typeof e.checked === "boolean" ? e.checked : undefined,
      selected: typeof e.selected === "boolean" ? e.selected : undefined,
      required: e.required === true || undefined,
      offscreen: e.offscreen === true || undefined,
      area: ["header", "nav", "footer"].includes(e.area) ? e.area : undefined,
      options: Array.isArray(e.options) ? e.options.slice(0, 60).map((o: any) => ({ j: Number(o.j), label: str(o.label, 100) })) : undefined,
    })).filter((e: any) => Number.isFinite(e.i)) : [];
    const snapshot: AgentSnapshot = { url: str(s.url, 500), title: str(s.title, 200), text: str(s.text, 6000), elements, errors: (Array.isArray(s.errors) ? s.errors : []).slice(0, 8).map((x: unknown) => str(x, 200)) };
    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.inputs || {}).slice(0, 20)) if (typeof v === "string") inputs[str(k, 80)] = v.slice(0, 200);
    const history: AgentHistoryItem[] = (Array.isArray(b.history) ? b.history : []).slice(-30).map((h: any) => ({ op: str(h.op, 30), i: Number.isFinite(Number(h.i)) ? Number(h.i) : undefined, label: str(h.label, 120), ok: h.ok === false ? false : undefined }));

    try {
      const t0 = Date.now();
      const rp = b.reply && typeof b.reply === "object" && typeof b.reply.text === "string"
        ? { field: b.reply.field === null ? null : str(b.reply.field, 120), text: str(b.reply.text, 300), auto: b.reply.auto === true }
        : undefined;
      const cmd = await decideStep({ goal: flow.description, request: str(b.request, 2000), inputs, snapshot, history, lang: b.lang === "en" || b.lang === "other" ? b.lang : "pl", reply: rp });
      console.log(`[agent] ${tenantId}/${flowId}: ${cmd.op}${"i" in cmd && cmd.i ? ` [${cmd.i}]` : ""} (${Date.now() - t0}ms)`);
      res.json(cmd);
    } catch (e: any) {
      console.warn(`[agent] ${tenantId}/${flowId}: ${e?.message || e}`);
      res.status(500).json({ error: "Agent step failed" });
    }
  });
}
