/**
 * POST /api/agent/step - one decision of a goal-driven ("agent") flow.
 * The widget sends a snapshot of the page; the goal comes ONLY from the
 * tenant's stored flow definition, so this endpoint cannot be used as a
 * general-purpose browsing agent. Rate-limited per IP.
 */
import type { Express, Request, RequestHandler } from "express";
import { getFlow, getFlows, saveFlow } from "../flows/flow-store.js";
import { getTenant } from "../multi-tenant/tenant-registry.js";
import type { FlowDefinition } from "../context/types.js";
import { jevAsk, jevEnabled } from "../llm/jev.js";
import { lexicalSnippets, type KnowledgeCatalog } from "../knowledge/catalog.js";
import { loadKnowledgeCatalog } from "../multi-tenant/tenant-manager.js";
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

// Tenant knowledge for matching the visitor's words to page options (10 min cache).
const catalogs = new Map<string, { cat: KnowledgeCatalog | null; at: number }>();
async function catalogFor(tenantId: string): Promise<KnowledgeCatalog | null> {
  const hit = catalogs.get(tenantId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.cat;
  const cat = await loadKnowledgeCatalog(tenantId);
  if (catalogs.size >= 50) catalogs.delete(catalogs.keys().next().value as string);
  catalogs.set(tenantId, { cat, at: Date.now() });
  return cat;
}

/** The goal Jev works from. A recorded flow's steps ride along as a hint only. */
export function agentGoal(flow: FlowDefinition): string {
  const hints = (flow.steps || []).map((s) => s.description).filter(Boolean).slice(0, 25);
  if (!hints.length) return flow.description;
  const path = hints.map((h, i) => `${i + 1}. ${h}`).join("\n").slice(0, 1200);
  return `${flow.description}\n\nHow the owner did it when recording (a hint only; the page may have changed, follow what the page shows):\n${path}`;
}

/** The start page must be on the tenant's own site: the widget runs the flow there. */
export function onTenantSite(url: string, siteUrl: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const site = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`).hostname.replace(/^www\./, "");
    const host = u.hostname.replace(/^www\./, "");
    return host === site || host.endsWith(`.${site}`);
  } catch { return false; }
}

// Validates an owner-written agent flow; returns the error message or the clean fields.
function agentFields(b: any, siteUrl: string): { error: string } | { name: string; goal: string; startUrl: string } {
  const name = str(b?.name, 120).trim(), goal = str(b?.goal, 2000).trim();
  let startUrl = str(b?.startUrl, 500).trim();
  if (startUrl && !/^https?:\/\//i.test(startUrl)) startUrl = `https://${startUrl}`;
  if (name.length < 3) return { error: "Give the flow a short name (e.g. \"Book an appointment\")." };
  if (goal.length < 20) return { error: "Describe what the assistant should do in a sentence or two." };
  if (!onTenantSite(startUrl, siteUrl)) return { error: `The start page must be on your site (${siteUrl}) - the assistant runs the flow there.` };
  return { name, goal, startUrl };
}

export interface AgentRouteDeps { auth: RequestHandler; onFlowsChanged: (tenantId: string) => void }

export function registerAgentRoutes(app: Express, deps?: AgentRouteDeps): void {
  if (deps) {
    // Owner creates a goal-driven flow by describing it (no recording needed).
    app.post("/api/dashboard/flows/agent", deps.auth, async (req, res) => {
      const tenantId = (req as any).tenantId as string;
      const f = agentFields(req.body, getTenant(tenantId)?.siteUrl || "");
      if ("error" in f) { res.status(400).json({ error: f.error }); return; }
      if ((await getFlows(tenantId)).length >= 50) { res.status(400).json({ error: "Flow limit reached (50)." }); return; }
      const now = new Date().toISOString();
      const flow: FlowDefinition = {
        id: `agent_${Date.now().toString(36)}`, name: f.name, description: f.goal, triggerPhrases: [], steps: [], requiredInputs: [],
        createdAt: now, updatedAt: now, status: "active", executionMode: "agent", startUrl: f.startUrl,
      };
      await saveFlow(tenantId, flow);
      deps.onFlowsChanged(tenantId);
      console.log(`[flows] ${tenantId}: agent flow "${flow.name}" created (${flow.startUrl})`);
      res.json(flow);
    });
    // Edit an agent flow's name / goal / start page.
    app.put("/api/dashboard/flows/:id/agent", deps.auth, async (req, res) => {
      const tenantId = (req as any).tenantId as string;
      const existing = await getFlow(tenantId, String(req.params.id));
      if (!existing || existing.executionMode !== "agent") { res.status(404).json({ error: "Not found" }); return; }
      const f = agentFields(req.body, getTenant(tenantId)?.siteUrl || "");
      if ("error" in f) { res.status(400).json({ error: f.error }); return; }
      const flow = await saveFlow(tenantId, { ...existing, name: f.name, description: f.goal, startUrl: f.startUrl, updatedAt: new Date().toISOString() });
      deps.onFlowsChanged(tenantId);
      res.json(flow);
    });
  }

  // Admin: Jev latency as seen from this server (raw fetch, no hedging).
  app.get("/api/admin/jev-probe", async (req, res) => {
    const secret = process.env.ADMIN_SECRET;
    if (!secret || req.query.secret !== secret) { res.status(403).json({ error: "Forbidden" }); return; }
    const n = Math.min(Number(req.query.n) || 10, 30);
    if (req.query.via === "jevAsk") {
      const ms: number[] = [];
      for (let k = 0; k < n; k++) { const t = Date.now(); const a = await jevAsk({ page: "Wybierz placówkę i termin badania. ".repeat(110) }, { a: { type: "noul", instructions: "Is this a date page?" } }, 8000); ms.push(a ? Date.now() - t : -(Date.now() - t)); }
      res.json({ via: "jevAsk", ms }); return;
    }
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
      const cat = await catalogFor(tenantId);
      const knowledge = cat ? (q: string) => lexicalSnippets(q, cat, 3) : undefined;
      const cmd = await decideStep({ knowledge, goal: agentGoal(flow), request: str(b.request, 2000), inputs, snapshot, history, lang: b.lang === "en" || b.lang === "other" ? b.lang : "pl", reply: rp });
      console.log(`[agent] ${tenantId}/${flowId}: ${cmd.op}${"i" in cmd && cmd.i ? ` [${cmd.i}]` : ""} (${Date.now() - t0}ms)`);
      res.json(cmd);
    } catch (e: any) {
      console.warn(`[agent] ${tenantId}/${flowId}: ${e?.message || e}`);
      res.status(500).json({ error: "Agent step failed" });
    }
  });
}
