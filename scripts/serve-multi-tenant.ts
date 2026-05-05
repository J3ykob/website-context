/**
 * Multi-tenant server — serves multiple website-context tenants from a single process.
 *
 * Required env vars:
 *   OPENROUTER_API_KEY — for LLM inference
 *
 * Optional env vars:
 *   PORT — server port (default: 3211)
 *   BGE_HOST — BGE embedding server host
 *   BGE_PORT — BGE embedding server port
 *   QDRANT_HOST — Qdrant server host
 *   QDRANT_PORT — Qdrant server port
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFile, writeFile, appendFile } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import express from "express";
import cors from "cors";
import {
  runMigrations,
  createTenant,
  getTenant,
  getTenantByDomain,
  updateTenant,
  listTenants,
  hashPassword,
  verifyPassword,
  createSession,
  validateSession,
  generateApiKey,
  ScrapeWorker,
  TenantManager,
} from "../src/multi-tenant/index.js";
import {
  saveFlow,
  getFlows,
  getFlow,
  deleteFlow,
  updateFlow,
} from "../src/flows/flow-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.PORT || "3211");

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY environment variable is required");
  process.exit(1);
}

// Initialize database
runMigrations();
console.log("[multi-tenant] Database initialized");

// Initialize services
const worker = new ScrapeWorker();
const tenantManager = new TenantManager();

// Express app
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// --- Rate limiting ---
const signupRateMap = new Map<string, { count: number; resetAt: number }>();
const chatRateMap = new Map<string, { mc: number; ms: number; hc: number; hs: number }>();

function checkSignupRate(ip: string): boolean {
  const now = Date.now();
  let entry = signupRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 3600000 };
    signupRateMap.set(ip, entry);
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

function checkChatRate(sessionId: string): { ok: boolean; retry?: number } {
  const now = Date.now();
  let e = chatRateMap.get(sessionId);
  if (!e) { e = { mc: 0, ms: now, hc: 0, hs: now }; chatRateMap.set(sessionId, e); }
  if (now - e.ms > 60000) { e.mc = 0; e.ms = now; }
  if (now - e.hs > 3600000) { e.hc = 0; e.hs = now; }
  if (e.mc >= 20) return { ok: false, retry: Math.ceil((e.ms + 60000 - now) / 1000) };
  if (e.hc >= 100) return { ok: false, retry: Math.ceil((e.hs + 3600000 - now) / 1000) };
  e.mc++; e.hc++;
  return { ok: true };
}

// Cleanup stale rate limit entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of signupRateMap) if (now > e.resetAt) signupRateMap.delete(k);
  for (const [k, e] of chatRateMap) if (now - e.hs > 3600000) chatRateMap.delete(k);
}, 600000);

// --- Auth middleware ---
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = authHeader.slice(7);
  const tenantId = validateSession(token);
  if (!tenantId) {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  (req as any).tenantId = tenantId;
  next();
}

// --- Public routes ---

// Landing page
app.get("/", (_, res) => {
  const landingPath = resolve(__dirname, "../public/landing/index.html");
  if (existsSync(landingPath)) {
    res.sendFile(landingPath);
  } else {
    res.json({ status: "ok", service: "website-context multi-tenant" });
  }
});

// Widget JS
app.get("/widget.js", (_, res) => {
  res.sendFile(resolve(__dirname, "../public/widget.js"));
});

// Create tenant
app.post("/api/tenants", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!checkSignupRate(ip)) {
    res.status(429).json({ error: "Too many signups. Try again later." });
    return;
  }

  const { email, siteUrl } = req.body;
  if (!email || !siteUrl) {
    res.status(400).json({ error: "email and siteUrl are required" });
    return;
  }

  // Validate URL
  try {
    new URL(siteUrl);
  } catch {
    res.status(400).json({ error: "Invalid siteUrl" });
    return;
  }

  // Check if domain already exists
  const domain = new URL(siteUrl).hostname;
  const existing = getTenantByDomain(domain);
  if (existing) {
    res.status(409).json({ error: "A tenant for this domain already exists", tenantId: existing.id });
    return;
  }

  try {
    const tenant = createTenant(email, siteUrl);

    // Generate API key
    const apiKey = generateApiKey();
    updateTenant(tenant.id, { apiKey });

    // Enqueue scrape job
    worker.enqueue(tenant.id, siteUrl);

    res.status(201).json({
      tenantId: tenant.id,
      domain: tenant.domain,
      status: tenant.status,
      apiKey,
    });
  } catch (error: any) {
    console.error("[create-tenant]", error.message);
    res.status(500).json({ error: "Failed to create tenant" });
  }
});

// Check tenant status
app.get("/api/tenants/:id/status", (req, res) => {
  const tenant = getTenant(req.params.id);
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  res.json({
    id: tenant.id,
    status: tenant.status,
    pagesCount: tenant.pagesCount,
    chunksCount: tenant.chunksCount,
    lastScrapedAt: tenant.lastScrapedAt,
  });
});

// Chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, sessionId, tenantId } = req.body;
    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: "messages required" });
      return;
    }
    if (!tenantId) {
      res.status(400).json({ error: "tenantId required" });
      return;
    }

    // Verify tenant exists and is active
    const tenant = getTenant(tenantId);
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (tenant.status !== "active") {
      res.status(503).json({ error: "Tenant is not ready yet", status: tenant.status });
      return;
    }

    // Rate limit per session
    const sessionKey = sessionId || `${tenantId}_default`;
    const rc = checkChatRate(sessionKey);
    if (!rc.ok) {
      res.status(429).json({ error: "Rate limited", retryAfter: rc.retry });
      return;
    }

    // Get chat instance for tenant
    const chat = await tenantManager.getChatForTenant(tenantId);

    console.log(`[chat:${tenantId}] "${(messages[messages.length - 1]?.content || "").slice(0, 60)}"`);
    const response = await chat.chat(messages, sessionKey);

    // Log conversation
    try {
      const logDir = resolve(__dirname, `../data/${tenantId}`);
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      await appendFile(resolve(logDir, "conversations.jsonl"), JSON.stringify({
        sessionId: sessionKey,
        timestamp: new Date().toISOString(),
        userMessage: messages[messages.length - 1]?.content || "",
        botResponse: response.message,
        flowInvoked: response.flowSession?.flowId || null,
        navigatedTo: response.navigateTo || null,
        hadToolCall: !!(response.flowSession || response.navigateTo),
      }) + "\n");
    } catch { /* ignore logging errors */ }

    res.json(response);
  } catch (error: any) {
    console.error("[chat error]", error.message);
    res.status(500).json({ error: "Chat failed" });
  }
});

// Global health check (for Render)
app.get("/api/health", (_, res) => {
  const tenants = listTenants();
  res.json({ status: "ok", tenants: tenants.length, active: tenants.filter(t => t.status === "active").length });
});

// Health check per tenant
app.get("/api/health/:tenantId", (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  res.json({
    status: tenant.status,
    domain: tenant.domain,
    pagesCount: tenant.pagesCount,
    chunksCount: tenant.chunksCount,
    lastScrapedAt: tenant.lastScrapedAt,
    workerProcessing: worker.isProcessing(),
    workerQueueLength: worker.getQueueLength(),
  });
});

// --- Auth routes ---

// Login
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
  }

  // Find tenant by email (check all tenants)
  const tenants = listTenants();
  const tenant = tenants.find((t) => t.email === email);
  if (!tenant) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  if (!tenant.ownerPasswordHash) {
    res.status(401).json({ error: "Password not set. Use setup-password endpoint." });
    return;
  }

  if (!verifyPassword(password, tenant.ownerPasswordHash)) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = createSession(tenant.id);
  res.json({ token, tenantId: tenant.id });
});

// Setup password (first-time)
app.post("/api/auth/setup-password", (req, res) => {
  const { tenantId, apiKey, password } = req.body;
  if (!tenantId || !apiKey || !password) {
    res.status(400).json({ error: "tenantId, apiKey, and password required" });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const tenant = getTenant(tenantId);
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  if (tenant.apiKey !== apiKey) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  if (tenant.ownerPasswordHash) {
    res.status(409).json({ error: "Password already set" });
    return;
  }

  const hash = hashPassword(password);
  updateTenant(tenantId, { ownerPasswordHash: hash });

  const token = createSession(tenantId);
  res.json({ token, tenantId });
});

// --- Dashboard routes (require auth) ---

// Dashboard HTML
app.get("/dashboard", authMiddleware, (_, res) => {
  res.sendFile(resolve(__dirname, "../public/dashboard.html"));
});

// Stats
app.get("/api/dashboard/stats", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  let total = 0, today = 0, flows = 0, gaps = 0;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  const cp = resolve(__dirname, `../data/${tenantId}/conversations.jsonl`);
  if (existsSync(cp)) {
    const content = await readFile(cp, "utf-8");
    for (const l of content.trim().split("\n").filter(Boolean)) {
      try {
        const e = JSON.parse(l);
        total++;
        if (new Date(e.timestamp) >= todayStart) today++;
        if (e.flowInvoked) flows++;
      } catch { /* skip */ }
    }
  }

  const qp = resolve(__dirname, `../data/${tenantId}/unknown_questions.jsonl`);
  if (existsSync(qp)) {
    const s = new Set<string>();
    const content = await readFile(qp, "utf-8");
    for (const l of content.trim().split("\n").filter(Boolean)) {
      try {
        const q = JSON.parse(l).question?.toLowerCase();
        if (q) s.add(q);
      } catch { /* skip */ }
    }
    gaps = s.size;
  }

  res.json({
    totalConversations: total,
    totalToday: today,
    questionsAnswered: Math.max(0, total - gaps),
    gapsFound: gaps,
    flowsExecuted: flows,
  });
});

// Conversations
app.get("/api/dashboard/conversations", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const fp = resolve(__dirname, `../data/${tenantId}/conversations.jsonl`);
  if (!existsSync(fp)) { res.json([]); return; }

  const lines = (await readFile(fp, "utf-8")).trim().split("\n").filter(Boolean);
  res.json(
    lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .slice(-limit)
      .reverse()
  );
});

// Unknown questions
app.get("/api/dashboard/unknown-questions", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const fp = resolve(__dirname, `../data/${tenantId}/unknown_questions.jsonl`);
  if (!existsSync(fp)) { res.json([]); return; }

  const lines = (await readFile(fp, "utf-8")).trim().split("\n").filter(Boolean);
  const seen = new Set<string>();
  res.json(
    lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((q: any) => {
        if (!q) return false;
        const k = q.question?.toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
  );
});

// Context notes
app.get("/api/dashboard/context-notes", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const notesPath = resolve(__dirname, `../data/${tenantId}/context_notes.json`);
  if (!existsSync(notesPath)) { res.json([]); return; }
  res.json(JSON.parse(await readFile(notesPath, "utf-8")));
});

app.post("/api/dashboard/context-notes", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { question, answer } = req.body;
  if (!question || !answer) { res.status(400).json({ error: "question and answer required" }); return; }

  const dir = resolve(__dirname, `../data/${tenantId}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const notesPath = resolve(dir, "context_notes.json");

  let notes: any[] = [];
  if (existsSync(notesPath)) notes = JSON.parse(await readFile(notesPath, "utf-8"));
  notes.push({ question, answer, addedAt: new Date().toISOString() });
  await writeFile(notesPath, JSON.stringify(notes, null, 2));

  // Update the cached chat instance if it exists
  try {
    const chat = await tenantManager.getChatForTenant(tenantId);
    chat.setContextNotes(notes);
  } catch { /* tenant may not be cached yet */ }

  res.status(201).json(notes[notes.length - 1]);
});

// Flows
app.get("/api/dashboard/flows/:id", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const flowId = req.params.id as string;
  const f = await getFlow(tenantId, flowId);
  f ? res.json(f) : res.status(404).json({ error: "Not found" });
});

app.put("/api/dashboard/flows/:id", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const flowId = req.params.id as string;
  const u = await updateFlow(tenantId, flowId, req.body);
  if (u) {
    // Reload flows in cached chat instance
    try {
      const chat = await tenantManager.getChatForTenant(tenantId);
      chat.loadFlows((await getFlows(tenantId)).filter((f) => f.status === "active"));
    } catch { /* ignore */ }
    res.json(u);
  } else {
    res.status(404).json({ error: "Not found" });
  }
});

app.delete("/api/dashboard/flows/:id", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const flowId = req.params.id as string;
  if (await deleteFlow(tenantId, flowId)) {
    try {
      const chat = await tenantManager.getChatForTenant(tenantId);
      chat.loadFlows((await getFlows(tenantId)).filter((f) => f.status === "active"));
    } catch { /* ignore */ }
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "Not found" });
  }
});

// Rescrape
app.post("/api/dashboard/rescrape", authMiddleware, (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenant = getTenant(tenantId);
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  const maxPages = parseInt(req.body.maxPages) || 20;
  worker.enqueue(tenantId, tenant.siteUrl, maxPages);

  res.json({ ok: true, message: "Rescrape job queued" });
});

// Chunks
app.get("/api/dashboard/chunks", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;

  // Load context meta to get page info
  const metaPath = resolve(__dirname, `../data/${tenantId}/context-meta.json`);
  if (!existsSync(metaPath)) { res.json({ total: 0, pages: [] }); return; }

  const meta = JSON.parse(await readFile(metaPath, "utf-8"));
  res.json({
    total: meta.chunksCount || 0,
    pages: meta.pages || [],
    note: "Chunk content is stored in Qdrant. Use search to find specific content.",
  });
});

// Embed code
app.get("/api/dashboard/embed-code", authMiddleware, (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenant = getTenant(tenantId);
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  const host = req.get("host") || `localhost:${port}`;
  const protocol = req.protocol || "http";
  const baseUrl = `${protocol}://${host}`;

  const embedCode = `<script>
(function() {
  var s = document.createElement('script');
  s.src = '${baseUrl}/widget.js';
  s.setAttribute('data-tenant-id', '${tenantId}');
  s.setAttribute('data-api-url', '${baseUrl}');
  document.head.appendChild(s);
})();
</script>`;

  res.json({ embedCode, tenantId, apiUrl: baseUrl });
});

// Static assets
app.use(express.static(resolve(__dirname, "../public")));

// Start server
app.listen(port, "0.0.0.0", () => {
  console.log(`[multi-tenant] Server ready on port ${port}`);
  console.log(`  Dashboard: http://localhost:${port}/dashboard`);
  console.log(`  API: http://localhost:${port}/api`);
});
