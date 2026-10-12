/**
 * Dashboard API for projects (only those the logged-in business takes part in):
 *   GET /api/dashboard/projects                    newest first, with its role
 *   GET /api/dashboard/projects/:id                detail: participants, events, consents,
 *                                                  files, requirements (+ verification)
 *   GET /api/dashboard/projects/:id/file?path=...  one file of the project repository
 *   POST /api/dashboard/projects/:id/agent         {instruction} - the project agent works on it (202)
 *   GET  /api/dashboard/projects/:id/agent         the agent run's state (finishes a completed run)
 *
 * For the visitor's widget (no login; the chat session id is the key - only that session's project):
 *   GET /api/chat/agent?tenantId&sessionId&projectId          the agent's reply when ready
 *   GET /api/chat/agent/file?tenantId&sessionId&projectId&path a file prepared for the customer
 */
import type { Express, RequestHandler } from "express";
import { projectsForTenant, projectDetail } from "./store.js";
import { listFiles, listRequirements, readFile, readFileBuffer } from "./repo.js";
import { agentEnabled, agentStatus, startAgentRun } from "./agent.js";
import { agentDelivery, CUSTOMER_DIR } from "./conversation.js";
import { getProject } from "./store.js";
import { logMessage } from "../storage/conversation-store.js";

export function registerProjectRoutes(app: Express, deps: { auth: RequestHandler }): void {
  const tid = (req: any) => req.tenantId as string;
  const member = async (id: string, tenantId: string) => {
    const d = await projectDetail(id);
    return d && (d.project.initiatorTenantId === tenantId || d.participants.some((p) => p.tenantId === tenantId)) ? d : null;
  };

  app.get("/api/dashboard/projects", deps.auth, async (req, res) => {
    try { res.json(await projectsForTenant(tid(req))); }
    catch (e: any) { res.status(500).json({ error: "Could not load projects." }); }
  });

  app.get("/api/dashboard/projects/:id", deps.auth, async (req, res) => {
    const d = await member(String(req.params.id), tid(req)).catch(() => null);
    if (!d) { res.status(404).json({ error: "Not found" }); return; }
    const [files, requirements] = await Promise.all([listFiles(d.project.id), listRequirements(d.project.id)]);
    res.json({ ...d, files, requirements });
  });

  app.get("/api/dashboard/projects/:id/file", deps.auth, async (req, res) => {
    const d = await member(String(req.params.id), tid(req)).catch(() => null);
    const path = String(req.query.path || "");
    if (!d || !path) { res.status(404).json({ error: "Not found" }); return; }
    const f = (await listFiles(d.project.id)).find((x) => x.path === path);
    const body = !f ? null : f.kind === "bin" ? await readFileBuffer(d.project.id, path) : await readFile(d.project.id, path);
    if (!f || body === null) { res.status(404).json({ error: "Not found" }); return; }
    const type = f.kind === "csv" ? "text/csv; charset=utf-8" : f.kind === "json" ? "application/json" : f.kind === "bin" ? "application/octet-stream" : "text/plain; charset=utf-8";
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", `attachment; filename="${path.split("/").pop()}"`);
    res.send(body);
  });

  app.post("/api/dashboard/projects/:id/agent", deps.auth, async (req, res) => {
    const d = await member(String(req.params.id), tid(req)).catch(() => null);
    if (!d) { res.status(404).json({ error: "Not found" }); return; }
    if (!agentEnabled()) { res.status(503).json({ error: "The project agent is not available." }); return; }
    const instruction = String(req.body?.instruction || "").trim();
    if (!instruction || instruction.length > 4000) { res.status(400).json({ error: "Describe the task (up to 4000 characters)." }); return; }
    const r = await startAgentRun(d.project.id, instruction, tid(req)).catch((e: any) => ({ error: String(e?.message || e) }));
    if ("error" in r) { res.status(409).json(r); return; }
    res.status(202).json(r);
  });

  app.get("/api/dashboard/projects/:id/agent", deps.auth, async (req, res) => {
    const d = await member(String(req.params.id), tid(req)).catch(() => null);
    if (!d) { res.status(404).json({ error: "Not found" }); return; }
    res.json((await agentStatus(d.project.id).catch(() => null)) || { status: "none" });
  });

  // The visitor's own conversation project only: same tenant, same chat session.
  const ownProject = async (q: any) => {
    const tenantId = String(q.tenantId || ""), sessionId = String(q.sessionId || ""), projectId = String(q.projectId || "");
    if (!tenantId || !sessionId || !projectId) return null;
    const p = await getProject(projectId).catch(() => null);
    return p && p.initiatorTenantId === tenantId && p.customerSession === sessionId ? p : null;
  };

  app.get("/api/chat/agent", async (req, res) => {
    const p = await ownProject(req.query);
    if (!p) { res.status(404).json({ error: "Not found" }); return; }
    try {
      const d = await agentDelivery(p.id, (message) => logMessage(p.initiatorTenantId, p.customerSession, "assistant", message, { flowInvoked: "project-agent" }));
      res.json({ ...d, files: (d.files || []).map((path) => ({ path, name: path.split("/").pop(), url: `/api/chat/agent/file?tenantId=${encodeURIComponent(p.initiatorTenantId)}&sessionId=${encodeURIComponent(p.customerSession)}&projectId=${encodeURIComponent(p.id)}&path=${encodeURIComponent(path)}` })) });
    } catch (e: any) {
      res.status(500).json({ error: "Could not load the result." });
    }
  });

  app.get("/api/chat/agent/file", async (req, res) => {
    const p = await ownProject(req.query);
    const path = String(req.query.path || "");
    if (!p || !path.startsWith(`${CUSTOMER_DIR}/`)) { res.status(404).json({ error: "Not found" }); return; }
    const f = (await listFiles(p.id)).find((x) => x.path === path);
    const body = !f ? null : f.kind === "bin" ? await readFileBuffer(p.id, path) : await readFile(p.id, path);
    if (!f || body === null) { res.status(404).json({ error: "Not found" }); return; }
    const type = f.kind === "csv" ? "text/csv; charset=utf-8" : f.kind === "json" ? "application/json" : f.kind === "bin" ? "application/octet-stream" : "text/plain; charset=utf-8";
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", `attachment; filename="${(path.split("/").pop() || "file").split('"').join("")}"`);
    res.send(f.kind === "csv" && typeof body === "string" && !body.startsWith("\uFEFF") ? "\uFEFF" + body : body);
  });
}
