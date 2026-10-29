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
 *
 * For the business (src/projects/review.ts):
 *   GET/PUT /api/dashboard/agent-review   {mode: "auto" | "approve"}
 *   GET  /review/:token                   the review page (link from the email, no login)
 *   GET  /api/review/:token               what to review: request, conversation, draft, files, checks
 *   GET  /api/review/:token/file?path=    a file prepared for the customer
 *   POST /api/review/:token               {action: approve | decline | changes, message?, note?}
 */
import type { Express, RequestHandler } from "express";
import { projectsForTenant, projectDetail } from "./store.js";
import { listFiles, listRequirements, readFile, readFileBuffer, writeFile } from "./repo.js";
import { agentEnabled, agentStatus } from "./agent.js";
import { agentDelivery, reworkWithGuidance, businessQuestions, deliverNow, setCustomerContact, projectByLink, NOTIFY, CUSTOMER_DIR } from "./conversation.js";
import { reviewByToken, decide, reviewMode, timeline } from "./review.js";
import { getTenant, updateTenant } from "../multi-tenant/d1-registry.js";
import { resolve } from "path";
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
    const { planAndRun } = await import("./plan.js");
    const r = await planAndRun(d.project.id, instruction, tid(req)).catch((e: any) => ({ error: String(e?.message || e) }));
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

  app.get("/api/dashboard/agent-review", deps.auth, (req, res) => {
    res.json({ mode: reviewMode(tid(req)) });
  });

  app.put("/api/dashboard/agent-review", deps.auth, (req, res) => {
    const mode = req.body?.mode === "approve" ? "approve" : req.body?.mode === "auto" ? "auto" : null;
    const t = getTenant(tid(req));
    if (!mode || !t) { res.status(400).json({ error: "mode must be auto or approve" }); return; }
    updateTenant(t.id, { settings: { ...(t.settings || {}), agentReview: mode } });
    res.json({ mode });
  });

  app.get("/review/:token", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.sendFile(resolve("public/review.html"));
  });

  app.get("/api/review/:token", async (req, res) => {
    const rv = await reviewByToken(String(req.params.token)).catch(() => null);
    if (!rv) { res.status(404).json({ error: "This link has expired or does not exist." }); return; }
    const t = getTenant(rv.tenantId);
    const [request, history, files, requirements, run] = await Promise.all([
      readFile(rv.projectId, "request.txt").catch(() => null),
      timeline(rv.projectId).catch(() => []),
      listFiles(rv.projectId),
      listRequirements(rv.projectId),
      getProject(rv.projectId).then((p) => p?.memory.agentRun as any),
    ]);
    const forCustomer = files.filter((f) => f.path.startsWith(`${CUSTOMER_DIR}/`) && (run?.files || []).includes(f.path));
    // Text files the owner can edit before they go out.
    const contents = await Promise.all(forCustomer.map((f) => f.kind !== "bin" && f.size < 200_000 ? readFile(rv.projectId, f.path).catch(() => null) : Promise.resolve(null)));
    const questions = rv.runId === run?.runId ? await businessQuestions(rv.projectId, run).catch(() => []) : [];
    // The businesses whose parts are in this result: each gets a colour on the page (own business first).
    const proj = await getProject(rv.projectId);
    const subs = ((proj?.memory.subRequests as any[]) || []);
    const slugs = (proj?.memory.businessSlugs as Record<string, string>) || {};
    const { businessLabel } = await import("./network.js");
    const nameKeys = (tenantId: string) => [businessLabel(tenantId), ...Object.entries(slugs).filter(([, id]) => id === tenantId).map(([sl]) => sl), getTenant(tenantId)?.domain || ""].filter(Boolean);
    const businesses = [
      { tenantId: rv.tenantId, label: businessLabel(rv.tenantId), own: true, status: "own", question: "", answer: "", keys: nameKeys(rv.tenantId) },
      ...subs.map((x) => ({ tenantId: x.tenantId, label: x.label, own: false, status: x.status, question: x.question, answer: "", keys: nameKeys(x.tenantId) })),
    ];
    for (const b of businesses) if (!b.own) {
      const ans = proj ? (await timeline(proj.id).catch(() => [])).find((e) => e.who === "business" && e.text.startsWith(b.label)) : null;
      b.answer = ans ? ans.text.slice(ans.text.indexOf("\n\n") + 2) : "";
    }
    res.json({
      brand: t?.settings?.siteCard?.brand || t?.brandName || t?.domain || "",
      status: rv.status, draft: ((proj?.memory.ownerDraft as any)?.runId === rv.runId ? (proj?.memory.ownerDraft as any).text : rv.draft), final: rv.final, note: rv.note, createdAt: rv.createdAt,
      chat: ((proj?.memory.ownerChat as any[]) || []).filter((t) => Date.parse(t.at) >= Date.parse(rv.createdAt)),
      request: request || "", history,
      questions, businesses,
      // A business that has not joined, invited to confirm or correct what its public data answered.
      listed: proj?.memory.listed ? { from: businessLabel(String(proj.memory.fromTenant || "")), confirmed: !!proj.memory.confirmedAt } : null,
      files: forCustomer.map((f, k) => ({ path: f.path, name: f.path.split("/").pop(), size: f.size, content: contents[k] === null ? null : (contents[k] as string).startsWith("\uFEFF") ? (contents[k] as string).slice(1) : contents[k], url: `/api/review/${encodeURIComponent(rv.token)}/file?path=${encodeURIComponent(f.path)}` })),
      plan: (await getProject(rv.projectId))?.memory.plan || null,
      checks: requirements.filter((q) => q.id.startsWith("sys-agent") || q.id.startsWith("spec-")).map((q) => ({ text: q.text, status: q.status, evidence: q.evidence })),
    });
  });

  app.get("/api/review/:token/file", async (req, res) => {
    const rv = await reviewByToken(String(req.params.token)).catch(() => null);
    const path = String(req.query.path || "");
    if (!rv || !path.startsWith(`${CUSTOMER_DIR}/`)) { res.status(404).json({ error: "Not found" }); return; }
    const f = (await listFiles(rv.projectId)).find((x) => x.path === path);
    const body = !f ? null : f.kind === "bin" ? await readFileBuffer(rv.projectId, path) : await readFile(rv.projectId, path);
    if (!f || body === null) { res.status(404).json({ error: "Not found" }); return; }
    res.setHeader("Content-Type", f.kind === "csv" ? "text/csv; charset=utf-8" : f.kind === "bin" ? "application/octet-stream" : "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `${req.query.inline ? "inline" : "attachment"}; filename="${(path.split("/").pop() || "file").split('"').join("")}"`);
    res.send(f.kind === "csv" && typeof body === "string" && !body.startsWith("\uFEFF") ? "\uFEFF" + body : body);
  });

  app.post("/api/review/:token", async (req, res) => {
    const token = String(req.params.token);
    const action = String(req.body?.action || "");
    const message = String(req.body?.message || "").trim();
    let note = String(req.body?.note || "").trim();
    // Answers to the assistant's questions: the agent reworks the result with them (same as changes).
    if (action === "answer") {
      const answers = (Array.isArray(req.body?.answers) ? req.body.answers : []).map((x: any) => ({ q: String(x?.q || "").slice(0, 500), a: String(x?.a || "").trim().slice(0, 2000) })).filter((x: any) => x.a);
      if (!answers.length && !note) { res.status(400).json({ error: "Answer at least one question." }); return; }
      note = [...answers.map((x: any) => `Pytanie: ${x.q}\nOdpowiedź firmy: ${x.a}`), ...(note ? [`Dodatkowo: ${note}`] : [])].join("\n\n");
    }
    if (action === "decline" && !message) { res.status(400).json({ error: "Write the message the customer will get." }); return; }
    if (action === "changes" && !note) { res.status(400).json({ error: "Describe what to change." }); return; }
    if (!["approve", "decline", "changes", "answer"].includes(action)) { res.status(400).json({ error: "Unknown action." }); return; }
    // Files the owner edited (only the customer's files of this result).
    const edits: Record<string, string> = action === "approve" && req.body?.files && typeof req.body.files === "object" ? req.body.files : {};
    const current = await reviewByToken(token).catch(() => null);
    if (current?.status === "pending" && Object.keys(edits).length) {
      const run = (await getProject(current.projectId))?.memory.agentRun as any;
      for (const [path, content] of Object.entries(edits)) {
        if (typeof content !== "string" || !path.startsWith(`${CUSTOMER_DIR}/`) || !(run?.files || []).includes(path) || content.length > 500_000) continue;
        const old = await readFile(current.projectId, path).catch(() => null);
        const plain = old && old.startsWith("\uFEFF") ? old.slice(1) : old;
        if (plain === content) continue;
        const ext = path.split(".").pop();
        await writeFile(current.projectId, path, content, ext === "csv" ? "csv" : ext === "md" ? "md" : ext === "json" ? "json" : "txt", `business:${current.tenantId}`);
      }
    }
    const rv = await decide(token, action === "approve" ? "approved" : action === "decline" ? "declined" : "changes_requested", { final: message, note }).catch(() => null);
    if (!rv) { res.status(409).json({ error: "This result was already decided, or the link has expired." }); return; }
    if (action === "changes" || action === "answer") await reworkWithGuidance(rv.projectId, note);
    else {
      // A business's answer to another business: back into the customer's project. A customer's result:
      // delivered now (logged in the chat, emailed if the customer asked) - the customer may have left.
      const { BUSINESS_REQUEST, settle } = await import("./network.js");
      const proj = await getProject(rv.projectId);
      if (proj?.type === BUSINESS_REQUEST) await settle(rv.projectId, (rv.final || rv.draft).trim(), (rv.final || rv.draft).trim() ? "answered" : "no_answer");
      else await deliverNow(rv.projectId).catch((e) => console.warn(`[review] ${rv.projectId}: delivery: ${e?.message || e}`));
    }
    res.json({ ok: true, status: rv.status });
  });

  // The owner's chat with the assistant about the result (src/projects/owner-chat.ts).
  app.post("/api/review/:token/chat", async (req, res) => {
    const rv = await reviewByToken(String(req.params.token)).catch(() => null);
    const message = String(req.body?.message || "").trim();
    if (!rv) { res.status(404).json({ error: "This link has expired or does not exist." }); return; }
    if (rv.status !== "pending") { res.status(409).json({ error: "This result was already decided." }); return; }
    if (!message || message.length > 4000) { res.status(400).json({ error: "Empty or too long message." }); return; }
    try {
      const { ownerChat } = await import("./owner-chat.js");
      const r = await ownerChat(rv, message);
      res.json({ reply: r.reply, draft: r.draft, rework: !!r.rework });
    } catch (e: any) {
      console.warn(`[owner-chat] ${rv.projectId}: ${e?.message || e}`);
      res.status(502).json({ error: "The assistant is not available right now - try again." });
    }
  });

  // The customer leaves an email to get the result of this project (consent recorded with its text).
  app.post("/api/chat/agent/notify", async (req, res) => {
    const p = await ownProject(req.body || {});
    if (!p) { res.status(404).json({ error: "Not found" }); return; }
    const email = String(req.body?.email || "").trim().slice(0, 200);
    const lang = NOTIFY[String(req.body?.lang)] ? String(req.body.lang) : "en";
    const at = email.indexOf("@");
    // Shape check of what the customer typed into the email field (not extraction from text).
    if (at < 1 || email.indexOf(".", at) < at + 2 || email.endsWith(".") || email.includes(" ") || req.body?.consent !== true) {
      res.status(400).json({ error: NOTIFY[lang].invalid }); return;
    }
    const brand = getTenant(p.initiatorTenantId)?.settings?.siteCard?.brand || getTenant(p.initiatorTenantId)?.brandName || getTenant(p.initiatorTenantId)?.domain || "";
    await setCustomerContact(p.id, p.initiatorTenantId, email, lang, NOTIFY[lang].consent.split("{brand}").join(brand));
    // Already finished while the customer was typing: send it now.
    await deliverNow(p.id).catch(() => {});
    res.json({ ok: true, message: NOTIFY[lang].saved.split("{email}").join(email) });
  });

  // The customer's page on whisp.so (link from the chat): status, then the result and its files.
  const linkProject = async (token: string) => {
    const id = await projectByLink(token);
    return id ? getProject(id) : null;
  };

  // A customer's request offered to a business that has not joined (src/projects/lead.ts).
  app.get("/lead/:token", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex");
    res.sendFile(resolve("public/lead.html"));
  });
  app.get("/api/lead/:token", async (req, res) => {
    const lead = await import("./lead.js");
    const token = String(req.params.token);
    try {
      if (req.query.session_id) await lead.confirmCheckout(token, String(req.query.session_id)).catch((e) => console.warn(`[lead] confirm: ${e?.message || e}`));
      const v = await lead.leadView(token);
      if (!v) { res.status(404).json({ error: "not_found" }); return; }
      res.json(v);
    } catch { res.status(500).json({ error: "unavailable" }); }
  });
  app.post("/api/lead/:token/checkout", async (req, res) => {
    const lead = await import("./lead.js");
    let base = (process.env.BASE_URL || "").trim();
    if (!base.startsWith("http")) base = "https://whisp.so";
    while (base.endsWith("/")) base = base.slice(0, -1);
    try {
      const v = await lead.leadView(String(req.params.token));
      if (!v || v.status !== "open") { res.status(409).json({ error: "Ta oferta nie jest już dostępna." }); return; }
      res.json({ url: await lead.startCheckout(String(req.params.token), base) });
    } catch (e: any) {
      console.warn(`[lead] checkout: ${e?.message || e}`);
      res.status(502).json({ error: "Płatność jest chwilowo niedostępna - spróbuj za moment." });
    }
  });
  app.post("/api/lead/:token/portal", async (req, res) => {
    const lead = await import("./lead.js");
    let base = (process.env.BASE_URL || "").trim();
    if (!base.startsWith("http")) base = "https://whisp.so";
    while (base.endsWith("/")) base = base.slice(0, -1);
    try { res.json({ url: await lead.portalUrl(String(req.params.token), base) }); }
    catch (e: any) { console.warn(`[lead] portal: ${e?.message || e}`); res.status(409).json({ error: "Brak subskrypcji do zarządzania." }); }
  });
  app.post("/api/lead/:token/dashboard", async (req, res) => {
    const lead = await import("./lead.js");
    const sess = await lead.dashboardSession(String(req.params.token)).catch(() => null);
    if (!sess) { res.status(409).json({ error: "Panel jest dostępny po subskrypcji." }); return; }
    res.json(sess);
  });
  app.post("/api/lead/:token/reply", async (req, res) => {
    const lead = await import("./lead.js");
    const offer = String(req.body?.offer || "").trim();
    if (offer.length < 5 || offer.length > 4000) { res.status(400).json({ error: "Napisz ofertę (do 4000 znaków)." }); return; }
    const ok = await lead.replyToLead(String(req.params.token), offer).catch(() => false);
    if (!ok) { res.status(409).json({ error: "Najpierw odblokuj zapytanie." }); return; }
    res.json({ ok: true });
  });
  // Reservations that ended unpaid: the request goes to the next business picked for the same part.
  // Results left waiting for the owner: owner reminded once, the customer's conversation told.
  const sweep = setInterval(() => {
    void import("./lead.js").then((l) => l.passExpiredLeads()).catch((e) => console.warn(`[lead] sweep: ${e?.message || e}`));
    void import("./review.js").then((r) => r.remindLateReviews()).then((n) => { if (n) console.log(`[review] ${n} late review(s): owner reminded, customer told`); }).catch((e) => console.warn(`[review] sweep: ${e?.message || e}`));
  }, 10 * 60_000);
  sweep.unref?.();

  app.get("/p/:token", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex");
    res.sendFile(resolve("public/p.html"));
  });

  app.get("/api/p/:token", async (req, res) => {
    const p = await linkProject(String(req.params.token)).catch(() => null);
    if (!p) { res.status(404).json({ error: "not_found" }); return; }
    const t = getTenant(p.initiatorTenantId);
    const lang = ((p.memory.customerContact as any)?.lang) || ((p.memory.plan as any)?.language) || "pl";
    try {
      const d = await agentDelivery(p.id, (message) => logMessage(p.initiatorTenantId, p.customerSession, "assistant", message, { flowInvoked: "project-agent" }));
      const waitingBusinesses = ((p.memory.subRequests as any[]) || []).some((s) => s.status === "waiting");
      const tok = encodeURIComponent(String(req.params.token));
      res.json({
        brand: t?.settings?.siteCard?.brand || t?.brandName || t?.domain || "", site: t?.siteUrl || "",
        lang: NOTIFY[lang] ? lang : "pl",
        request: ((await readFile(p.id, "request.txt").catch(() => null)) || "").slice(0, 2000),
        status: d.status === "running" && waitingBusinesses ? "partners" : d.status,
        message: d.status === "done" || d.status === "failed" ? d.message : "",
        files: d.status === "done" ? (d.files || []).map((path) => ({ name: path.split("/").pop(), url: `/api/p/${tok}/file?path=${encodeURIComponent(path)}` })) : [],
        notified: !!(p.memory.customerContact as any)?.email,
        // The businesses asked for an estimate and where each stands (an offer, no reply in time, still waiting).
        asked: await (async () => {
          const subs = ((p.memory.subRequests as any[]) || []);
          const { invitesFor } = await import("./lead.js");
          const inv = await invitesFor(subs.map((s) => s.id)).catch(() => ({} as Record<string, any>));
          const offers = ((p.memory.businessOffers as any[]) || []);
          const window = (Number(process.env.LEAD_EXCLUSIVE_HOURS) || 24) * 3600_000;
          return subs.map((s) => {
            const i = inv[s.id];
            const state = offers.some((o) => o.tenantId === s.tenantId) ? "offer"
              : i ? (i.passed_at || Date.now() - Date.parse(i.created_at) > window ? "no_reply" : "waiting")
              : s.status === "answered" ? (s.ownerAsked ? "waiting" : "answered") : s.status === "no_answer" ? "no_reply" : "waiting";
            return { business: String(s.label || s.tenantId), state };
          });
        })(),
        // Ways to be told when it's ready (only the configured ones) and which the customer already chose.
        channels: (await import("./notify-channels.js")).availableChannels(),
        chosen: Object.keys((p.memory.customerContact as any) || {}).filter((k) => ["email", "phone", "whatsapp", "telegramChatId"].includes(k)),
        telegram: (await import("./notify-channels.js")).telegramLink(String(req.params.token)),
        consents: Object.fromEntries((["sms", "whatsapp", "telegram"] as const).map((c) => [c, CHANNEL_TEXT[NOTIFY[lang] ? lang : "pl"].consent.split("{brand}").join(t?.settings?.siteCard?.brand || t?.brandName || t?.domain || "").split("{channel}").join(c === "sms" ? "SMS" : c === "whatsapp" ? "WhatsApp" : "Telegram")])),
        // Offers businesses of the network sent afterwards (src/projects/lead.ts).
        offers: ((p.memory.businessOffers as any[]) || []).map((o) => ({ business: String(o.label || ""), text: String(o.text || ""), at: o.at })),
        consent: NOTIFY[NOTIFY[lang] ? lang : "pl"].consent.split("{brand}").join(t?.settings?.siteCard?.brand || t?.brandName || t?.domain || ""),
      });
    } catch (e: any) {
      res.status(500).json({ error: "unavailable" });
    }
  });

  app.get("/api/p/:token/file", async (req, res) => {
    const p = await linkProject(String(req.params.token)).catch(() => null);
    const path = String(req.query.path || "");
    const run = p?.memory.agentRun as any;
    if (!p || !path.startsWith(`${CUSTOMER_DIR}/`) || !(run?.files || []).includes(path) || (p.memory.delivered as string) !== run?.runId) { res.status(404).json({ error: "Not found" }); return; }
    const f = (await listFiles(p.id)).find((x) => x.path === path);
    const body = !f ? null : f.kind === "bin" ? await readFileBuffer(p.id, path) : await readFile(p.id, path);
    if (!f || body === null) { res.status(404).json({ error: "Not found" }); return; }
    res.setHeader("Content-Type", f.kind === "csv" ? "text/csv; charset=utf-8" : f.kind === "bin" ? "application/octet-stream" : "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${(path.split("/").pop() || "file").split('"').join("")}"`);
    res.send(f.kind === "csv" && typeof body === "string" && !body.startsWith("\uFEFF") ? "\uFEFF" + body : body);
  });

  app.post("/api/p/:token/notify", async (req, res) => {
    const p = await linkProject(String(req.params.token)).catch(() => null);
    if (!p) { res.status(404).json({ error: "Not found" }); return; }
    const lang = NOTIFY[String(req.body?.lang)] ? String(req.body.lang) : "pl";
    const brand = getTenant(p.initiatorTenantId)?.settings?.siteCard?.brand || getTenant(p.initiatorTenantId)?.brandName || getTenant(p.initiatorTenantId)?.domain || "";
    // SMS / WhatsApp: a phone number with consent (only channels configured on this server).
    const channel = String(req.body?.channel || "email");
    if (channel === "sms" || channel === "whatsapp") {
      const { availableChannels, normalizePhone } = await import("./notify-channels.js");
      const phone = normalizePhone(String(req.body?.phone || ""));
      if (!availableChannels().includes(channel) || !phone || req.body?.consent !== true) { res.status(400).json({ error: CHANNEL_TEXT[lang].invalidPhone }); return; }
      const { setCustomerChannel } = await import("./conversation.js");
      await setCustomerChannel(p.id, p.initiatorTenantId, channel, phone, lang, CHANNEL_TEXT[lang].consent.split("{brand}").join(brand).split("{channel}").join(channel === "sms" ? "SMS" : "WhatsApp"));
      await deliverNow(p.id).catch(() => {});
      res.json({ ok: true, message: CHANNEL_TEXT[lang].saved.split("{to}").join(phone) });
      return;
    }
    const email = String(req.body?.email || "").trim().slice(0, 200);
    const at = email.indexOf("@");
    if (at < 1 || email.indexOf(".", at) < at + 2 || email.endsWith(".") || email.includes(" ") || req.body?.consent !== true) { res.status(400).json({ error: NOTIFY[lang].invalid }); return; }
    await setCustomerContact(p.id, p.initiatorTenantId, email, lang, NOTIFY[lang].consent.split("{brand}").join(brand));
    await deliverNow(p.id).catch(() => {});
    res.json({ ok: true, message: NOTIFY[lang].saved.split("{email}").join(email) });
  });

  // Telegram: the customer opens t.me/<bot>?start=<token> from the status page; the bot links that chat to the request.
  app.post("/api/telegram/webhook", async (req, res) => {
    if (!process.env.TELEGRAM_WEBHOOK_SECRET || req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) { res.status(403).end(); return; }
    res.json({ ok: true });
    const msg = req.body?.message;
    const m = String(msg?.text || "").match(/^\/start\s+(\S+)/);
    if (!m || !msg?.chat?.id) return;
    const p = await linkProject(m[1]).catch(() => null);
    const { telegramSend } = await import("./notify-channels.js");
    if (!p) { if (process.env.CUSTOMER_UPDATES_APPROVED === "1") await telegramSend(msg.chat.id, CHANNEL_TEXT.pl.telegramUnknown).catch(() => {}); return; }
    const lang = ((p.memory.customerContact as any)?.lang) || ((p.memory.plan as any)?.language) || "pl";
    const L = CHANNEL_TEXT[CHANNEL_TEXT[lang] ? lang : "pl"];
    const t = getTenant(p.initiatorTenantId);
    const brand = t?.settings?.siteCard?.brand || t?.brandName || t?.domain || "";
    const { setCustomerChannel } = await import("./conversation.js");
    await setCustomerChannel(p.id, p.initiatorTenantId, "telegram", String(msg.chat.id), lang, L.consent.split("{brand}").join(brand).split("{channel}").join("Telegram"));
    if (process.env.CUSTOMER_UPDATES_APPROVED === "1") await telegramSend(msg.chat.id, L.telegramLinked.split("{brand}").join(brand)).catch(() => {});
    await deliverNow(p.id).catch(() => {});
  });
}

// Status-page texts for SMS / WhatsApp / Telegram (UI labels and the bot's own confirmations, not chat replies).
const CHANNEL_TEXT: Record<string, { consent: string; saved: string; invalidPhone: string; telegramLinked: string; telegramUnknown: string }> = {
  pl: { consent: "Zgadzam się, aby {brand} powiadomił mnie przez {channel}, gdy wynik tego zapytania będzie gotowy.", saved: "Dziękujemy - powiadomimy Cię na {to}.", invalidPhone: "Sprawdź numer telefonu.", telegramLinked: "Gotowe - napiszemy tutaj, gdy odpowiedź od {brand} będzie gotowa.", telegramUnknown: "Ten link wygasł albo nie istnieje." },
  en: { consent: "I agree that {brand} notifies me by {channel} when the result of this request is ready.", saved: "Thanks - we'll notify you at {to}.", invalidPhone: "Please check the phone number.", telegramLinked: "Done - we'll message you here when the answer from {brand} is ready.", telegramUnknown: "This link has expired or does not exist." },
  uk: { consent: "Я погоджуюся, щоб {brand} повідомив мене через {channel}, коли результат цього запиту буде готовий.", saved: "Дякуємо - повідомимо вас на {to}.", invalidPhone: "Перевірте номер телефону.", telegramLinked: "Готово - напишемо тут, коли відповідь від {brand} буде готова.", telegramUnknown: "Посилання недійсне." },
  fr: { consent: "J'accepte que {brand} me prévienne par {channel} quand le résultat de cette demande sera prêt.", saved: "Merci - nous vous préviendrons au {to}.", invalidPhone: "Vérifiez le numéro de téléphone.", telegramLinked: "C'est fait - nous vous écrirons ici quand la réponse de {brand} sera prête.", telegramUnknown: "Ce lien a expiré ou n'existe pas." },
  de: { consent: "Ich bin einverstanden, dass {brand} mich per {channel} benachrichtigt, wenn das Ergebnis dieser Anfrage fertig ist.", saved: "Danke - wir benachrichtigen Sie unter {to}.", invalidPhone: "Bitte prüfen Sie die Telefonnummer.", telegramLinked: "Erledigt - wir schreiben Ihnen hier, wenn die Antwort von {brand} fertig ist.", telegramUnknown: "Dieser Link ist abgelaufen oder existiert nicht." },
};
