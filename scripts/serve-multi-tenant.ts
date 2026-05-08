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
  logMessage,
  getConversations,
  getConversationStats,
  getMessages,
  getFirstMessages,
  getIntentBreakdown,
  getTopQuestions,
  logUnknownQuestion,
  getUnknownQuestions,
  clearUnknownQuestions,
} from "../src/storage/conversation-store.js";
import { randomBytes } from "crypto";
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
  sendWelcomeEmail,
} from "../src/multi-tenant/index.js";
import {
  saveFlow,
  getFlows,
  getFlow,
  deleteFlow,
  updateFlow,
} from "../src/flows/flow-store.js";
import {
  detectPlatform,
  extractMessage,
  sendReply,
  verifyWebhook,
  getVerifyToken,
  validateConfig,
  ChannelSessionStore,
} from "../src/channels/index.js";
import type { MetaChannelConfig } from "../src/channels/index.js";

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
worker.recoverStuckJobs();
const tenantManager = new TenantManager();
const channelSessions = new ChannelSessionStore();

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

// Public widget config (for embed snippet to fetch startExpanded etc.)
app.get("/api/widget-config/:tenantId", (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  if (!tenant) { res.status(404).json({}); return; }
  const s = tenant.settings || {};
  res.json({
    startExpanded: s.startExpanded || false,
    forceTheme: s.forceTheme || "auto",
    brandName: s.brandName || tenant.brandName || "",
  });
});

// Tenant screenshot (for demo background)
app.get("/api/screenshot/:tenantId", (req, res) => {
  const screenshotPath = resolve(__dirname, `../data/${req.params.tenantId}/screenshot.png`);
  if (existsSync(screenshotPath)) {
    res.sendFile(screenshotPath);
  } else {
    res.status(404).json({ error: "No screenshot available" });
  }
});

// Demo page — standalone chat for a tenant (no embed needed)
app.get("/demo/:tenantId", (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  if (!tenant || tenant.status !== "active") {
    res.status(404).send("<!DOCTYPE html><html><body style='font-family:Archivo,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#57534e'><p>This bot is not ready yet. Check back soon.</p></body></html>");
    return;
  }
  const isReady = true;

  // Always use HTTPS in production (Render terminates TLS at the proxy)
  const host = req.get("host") || "website-context-dwoj.onrender.com";
  const baseUrl = process.env.BASE_URL || "https://" + host;
  const brand = tenant.brandName || tenant.domain;

  res.send('<!DOCTYPE html>\
<html lang="en">\
<head>\
<meta charset="UTF-8">\
<meta name="viewport" content="width=device-width, initial-scale=1.0">\
<title>' + brand + ' — AI Assistant</title>\
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Archivo:wght@400;500;600;700&display=swap" rel="stylesheet">\
<style>\
* { margin:0; padding:0; box-sizing:border-box; }\
body { font-family:"Archivo",sans-serif; background:#fafaf8; min-height:100vh; display:flex; flex-direction:column; }\
.demo-header {\
  padding:16px 28px; display:flex; align-items:center; justify-content:space-between;\
  border-bottom:1px solid #e7e5e4; background:#fff;\
}\
.demo-brand { display:flex; align-items:center; gap:12px; }\
.demo-mark { width:28px; height:28px; background:#ea580c; border-radius:8px; position:relative; }\
.demo-mark::before { content:""; position:absolute; inset:5px; border:2px solid #fff; border-radius:4px; }\
.demo-name { font-size:15px; font-weight:700; color:#1c1917; }\
.demo-badge { font-size:11px; font-weight:600; color:#ea580c; background:#fff7ed; border:1px solid #fed7aa; padding:4px 12px; border-radius:12px; }\
.demo-cta {\
  padding:10px 20px; background:#ea580c; color:#fff; border:none; border-radius:12px;\
  font-family:inherit; font-size:13px; font-weight:700; cursor:pointer; text-decoration:none;\
  transition: all 0.2s;\
}\
.demo-cta:hover { background:#c2410c; transform:translateY(-1px); }\
.demo-body { flex:1; position:relative; overflow-y:auto; }\
.demo-bg { position:relative; z-index:0; }\
.demo-bg img { width:100%; display:block; }\
.demo-info {\
  position:fixed; bottom:100px; left:50%; transform:translateX(-50%);\
  background:#fff; border:1px solid #e7e5e4; border-radius:16px; padding:20px 28px;\
  box-shadow:0 4px 24px rgba(0,0,0,0.08); z-index:10; text-align:center;\
  max-width:400px; width:calc(100% - 40px); animation: fadeUp 0.5s ease 1s both;\
}\
@keyframes fadeUp { from{opacity:0;transform:translateX(-50%) translateY(10px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }\
.demo-info h3 { font-family:"DM Serif Display",serif; font-size:20px; margin-bottom:6px; color:#1c1917; }\
.demo-info p { font-size:14px; color:#57534e; line-height:1.6; margin-bottom:16px; }\
.demo-info .arrow { font-size:20px; color:#a8a29e; animation:bounce 1.5s ease infinite; }\
@keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(6px)} }\
.demo-dismiss { font-size:12px; color:#a8a29e; cursor:pointer; border:none; background:none; font-family:inherit; }\
.demo-dismiss:hover { color:#1c1917; }\
@media(max-width:600px) { .demo-cta { display:none; } }\
</style>\
</head>\
<body>\
<div class="demo-header">\
  <div class="demo-brand">\
    <span class="demo-mark"></span>\
    <span class="demo-name">' + brand + '</span>\
    <span class="demo-badge">AI Assistant</span>\
  </div>\
  <a class="demo-cta" href="/">Get this for your website — free</a>\
</div>\
<div class="demo-body">\
  <div class="demo-bg"><img src="' + baseUrl + '/api/screenshot/' + tenant.id + '" alt="" loading="eager" onerror="this.parentElement.style.display=\'none\'" /></div>\
  <div class="demo-info" id="demo-info">\
    <h3>Try it out!</h3>\
    <p>This AI knows everything about <strong>' + brand + '</strong>. Just start typing below to ask any question.</p>\
    <div class="arrow">↓</div>\
    <button class="demo-dismiss" onclick="document.getElementById(\'demo-info\').style.display=\'none\'">Dismiss</button>\
  </div>\
</div>\
<script>\
window.addEventListener("load", function(){\
  var c={"tenantId":"' + tenant.id + '","apiHost":"' + baseUrl + '","brandName":"' + brand.replace(/"/g, '\\"') + '","forceTheme":"dark","startExpanded":' + (tenant.settings?.startExpanded ? 'true' : 'false') + '};\
  window.__wctx=c;\
  var s=document.createElement("script");\
  s.src=c.apiHost+"/widget.js";\
  s.async=true;\
  document.head.appendChild(s);\
});\
</script>\
</body>\
</html>');
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

    // Generate setup token for password setup email
    const setupToken = randomBytes(32).toString("hex");
    updateTenant(tenant.id, { apiKey, setupToken });

    // Enqueue scrape job
    worker.enqueue(tenant.id, siteUrl);

    // Send welcome email with setup link
    const protocol = req.protocol || "http";
    const host = req.get("host") || `localhost:${port}`;
    const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;
    sendWelcomeEmail(email, tenant.id, setupToken, baseUrl).catch((err) => {
      console.error("[create-tenant] Failed to send welcome email:", err.message);
    });

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

    // Log each message individually to Qdrant (enables per-message analytics)
    const lastUserContent = messages[messages.length - 1]?.content || "";
    logMessage(tenantId, sessionKey, "user", lastUserContent).catch(() => {});
    logMessage(tenantId, sessionKey, "assistant", response.message, {
      flowInvoked: response.flowSession?.flowId || null,
      navigatedTo: response.navigateTo || null,
      hadToolCall: !!(response.flowSession || response.navigateTo),
    }).catch(() => {});

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

// Public onboarding stats — live queue for landing page social proof
app.get("/api/onboarding-stats", (_, res) => {
  const tenants = listTenants();
  const active = tenants.filter(t => t.status === "active" && t.chunksCount > 0);
  const scraping = tenants.filter(t => t.status === "scraping");
  const pending = tenants.filter(t => t.status === "pending");
  const queued = scraping.length + pending.length;

  const recentlyCompleted = active
    .filter(t => t.lastScrapedAt)
    .sort((a, b) => new Date(b.lastScrapedAt!).getTime() - new Date(a.lastScrapedAt!).getTime())
    .slice(0, 5)
    .map(t => ({
      domain: t.domain,
      completedAt: t.lastScrapedAt,
      pages: t.pagesCount,
    }));

  res.json({
    total: tenants.length,
    active: active.length,
    queued,
    scraping: scraping.length,
    pending: pending.length,
    recentlyCompleted,
    workerBusy: worker.isProcessing(),
  });
});

// Admin rescrape single tenant (?maxPages=10 to limit crawl size)
app.post("/api/admin/rescrape/:tenantId", (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
  const maxPages = parseInt(req.query.maxPages as string) || 20;
  worker.enqueue(tenant.id, tenant.siteUrl, maxPages);
  updateTenant(tenant.id, { status: "scraping" });
  tenantManager.evictTenant(tenant.id);
  res.json({ ok: true, status: "scraping", maxPages });
});

// Admin bulk rescrape — re-enqueue all pending/error tenants
app.post("/api/admin/rescrape-all", (req, res) => {
  const tenants = listTenants();
  const targets = tenants.filter(t => t.status === "pending" || t.status === "error" || (t.status === "active" && t.pagesCount === 0));
  const maxPages = parseInt(req.query.maxPages as string) || 10;
  let queued = 0;
  for (const t of targets) {
    worker.enqueue(t.id, t.siteUrl, maxPages);
    updateTenant(t.id, { status: "scraping" });
    tenantManager.evictTenant(t.id);
    queued++;
  }
  res.json({ ok: true, queued, tenants: targets.map(t => t.id) });
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

// Setup password (first-time) — accepts either setup token or API key
app.post("/api/auth/setup-password", (req, res) => {
  const { tenantId, apiKey, token: setupToken, password } = req.body;
  if (!tenantId || !password) {
    res.status(400).json({ error: "tenantId and password required" });
    return;
  }

  if (!apiKey && !setupToken) {
    res.status(400).json({ error: "Either apiKey or token is required" });
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

  // Validate via setup token or API key
  if (setupToken) {
    if (!tenant.setupToken || tenant.setupToken !== setupToken) {
      res.status(401).json({ error: "Invalid or expired setup token" });
      return;
    }
  } else if (apiKey) {
    if (tenant.apiKey !== apiKey) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
  }

  if (tenant.ownerPasswordHash) {
    res.status(409).json({ error: "Password already set" });
    return;
  }

  const hash = hashPassword(password);
  // Clear setup token after use
  updateTenant(tenantId, { ownerPasswordHash: hash, setupToken: null });

  const sessionToken = createSession(tenantId);
  res.json({ token: sessionToken, tenantId });
});

// --- Auth pages ---
app.get("/auth/login", (_, res) => {
  res.sendFile(resolve(__dirname, "../public/auth/login.html"));
});

app.get("/auth/setup", (_, res) => {
  res.sendFile(resolve(__dirname, "../public/auth/setup.html"));
});

// --- Dashboard routes (require auth) ---

// Dashboard HTML (auth handled client-side via localStorage token)
app.get("/dashboard", (_, res) => {
  res.sendFile(resolve(__dirname, "../public/dashboard.html"));
});

// Stats
app.get("/api/dashboard/stats", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  try {
    const convoStats = await getConversationStats(tenantId);
    const gaps = await getUnknownQuestions(tenantId);
    res.json({
      totalConversations: convoStats.totalConversations,
      totalToday: convoStats.totalToday,
      questionsAnswered: Math.max(0, convoStats.totalConversations - gaps.length),
      gapsFound: gaps.length,
      flowsExecuted: convoStats.flowsExecuted,
    });
  } catch { res.json({ totalConversations: 0, totalToday: 0, questionsAnswered: 0, gapsFound: 0, flowsExecuted: 0 }); }
});

// Conversations (from Qdrant — persists across deploys)
app.get("/api/dashboard/conversations", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  res.json(await getConversations(tenantId, limit));
});

// Unknown questions (from Qdrant)
app.get("/api/dashboard/unknown-questions", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  res.json(await getUnknownQuestions(tenantId));
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

// Flows list
app.get("/api/dashboard/flows", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  res.json(await getFlows(tenantId));
});

// Flow by ID
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
// Widget settings (startExpanded, theme, etc.)
app.get("/api/dashboard/widget-settings", authMiddleware, (req, res) => {
  const tenant = getTenant((req as any).tenantId);
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
  const settings = tenant.settings || {};
  res.json({
    startExpanded: settings.startExpanded || false,
    forceTheme: settings.forceTheme || "auto",
    brandName: settings.brandName || tenant.brandName || "",
  });
});

app.put("/api/dashboard/widget-settings", authMiddleware, (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenant = getTenant(tenantId);
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
  const current = tenant.settings || {};
  const updated = { ...current, ...req.body };
  updateTenant(tenantId, { settings: updated });
  res.json({ ok: true, settings: updated });
});

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

// ─── Analytics endpoints ─────────────────────────────────────────────────

// First messages people send (entry intent)
app.get("/api/dashboard/analytics/first-messages", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  res.json(await getFirstMessages(tenantId, limit));
});

// Intent breakdown (question, action_request, greeting, complaint, etc.)
app.get("/api/dashboard/analytics/intents", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  res.json(await getIntentBreakdown(tenantId));
});

// Top questions asked
app.get("/api/dashboard/analytics/top-questions", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  res.json(await getTopQuestions(tenantId, limit));
});

// Raw messages (filterable)
app.get("/api/dashboard/analytics/messages", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const role = req.query.role as "user" | "assistant" | undefined;
  const sessionId = req.query.sessionId as string | undefined;
  res.json(await getMessages(tenantId, { limit, role, sessionId }));
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

// ─── Meta Channel Webhook Routes ────────────────────────────────────────────

// GET — Meta webhook verification (hub.challenge echo)
app.get("/api/webhooks/meta/:tenantId", (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).send("Not found");
    return;
  }

  const settings = tenant.settings || {};
  const channelConfig = settings.channels as MetaChannelConfig | undefined;
  if (!channelConfig) {
    res.status(404).send("No channel config");
    return;
  }

  // Try to find a matching verify token across all configured platforms
  const verifyToken = getVerifyToken(channelConfig);
  if (!verifyToken) {
    res.status(404).send("No verify token configured");
    return;
  }

  const challenge = verifyWebhook(req.query, verifyToken);
  if (challenge) {
    console.log(`[meta-webhook] Verified webhook for tenant ${req.params.tenantId}`);
    res.status(200).send(challenge);
  } else {
    res.status(403).send("Verification failed");
  }
});

// POST — Receive messages from WhatsApp/Messenger/Instagram
app.post("/api/webhooks/meta/:tenantId", (req, res) => {
  const tenantId = req.params.tenantId;

  // Always respond 200 immediately — Meta requires a response within 5 seconds
  res.status(200).send("EVENT_RECEIVED");

  // Process the webhook asynchronously
  processMetaWebhook(tenantId, req.body).catch((err) => {
    console.error(`[meta-webhook:${tenantId}] Error processing webhook:`, err.message);
  });
});

async function processMetaWebhook(tenantId: string, body: any): Promise<void> {
  const tenant = getTenant(tenantId);
  if (!tenant || tenant.status !== "active") {
    console.warn(`[meta-webhook:${tenantId}] Tenant not found or not active`);
    return;
  }

  const settings = tenant.settings || {};
  const channelConfig = settings.channels as MetaChannelConfig | undefined;
  if (!channelConfig) {
    console.warn(`[meta-webhook:${tenantId}] No channel config for tenant`);
    return;
  }

  // Detect which platform sent the message
  const platform = detectPlatform(body);
  if (!platform) {
    console.warn(`[meta-webhook:${tenantId}] Could not detect platform from payload`);
    return;
  }

  // Extract the message
  const extracted = extractMessage(platform, body);
  if (!extracted) {
    // Not a text message (could be status update, read receipt, etc.) — ignore silently
    return;
  }

  const { senderId, text, messageId } = extracted;
  const sessionKey = ChannelSessionStore.buildKey(platform, senderId);

  console.log(`[meta-webhook:${tenantId}:${platform}] Message from ${senderId}: "${text.slice(0, 60)}"`);

  try {
    // Add user message to session history and get full conversation
    const messages = channelSessions.addUserMessage(sessionKey, text);

    // Get chat instance for this tenant
    const chat = await tenantManager.getChatForTenant(tenantId);

    // Generate response
    const response = await chat.chat(messages, sessionKey);

    // Store assistant response in session
    channelSessions.addAssistantMessage(sessionKey, response.message);

    // Send reply via Graph API
    await sendReply(platform, channelConfig, senderId, response.message);

    // Log the conversation
    logMessage(tenantId, sessionKey, "user", text).catch(() => {});
    logMessage(tenantId, sessionKey, "assistant", response.message, {
      flowInvoked: response.flowSession?.flowId || null,
      navigatedTo: response.navigateTo || null,
      hadToolCall: !!(response.flowSession || response.navigateTo),
    }).catch(() => {});

    console.log(`[meta-webhook:${tenantId}:${platform}] Replied to ${senderId}`);
  } catch (err: any) {
    console.error(`[meta-webhook:${tenantId}:${platform}] Failed to process message:`, err.message);

    // Try to send a fallback error message to the user
    try {
      await sendReply(
        platform,
        channelConfig,
        senderId,
        "Sorry, I'm having trouble right now. Please try again in a moment."
      );
    } catch {
      // If even the error message fails, just log it
      console.error(`[meta-webhook:${tenantId}:${platform}] Failed to send error message`);
    }
  }
}

// ─── Dashboard Channel Config Endpoints ─────────────────────────────────────

// GET — Retrieve current channel configuration
app.get("/api/dashboard/channels", authMiddleware, (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenant = getTenant(tenantId);
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const settings = tenant.settings || {};
  const channels = settings.channels || {};

  // Return config but redact access tokens for security
  const redacted = redactChannelConfig(channels as MetaChannelConfig);

  res.json({
    channels: redacted,
    webhookUrl: `${process.env.BASE_URL || `https://${req.get("host")}`}/api/webhooks/meta/${tenantId}`,
  });
});

// PUT — Save channel configuration
app.put("/api/dashboard/channels", authMiddleware, (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenant = getTenant(tenantId);
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const channelConfig = req.body as MetaChannelConfig;

  // Validate the configuration
  const validation = validateConfig(channelConfig);
  if (!validation.valid) {
    res.status(400).json({ error: "Invalid channel configuration", details: validation.errors });
    return;
  }

  // Merge into existing settings
  const settings = tenant.settings || {};
  settings.channels = channelConfig;

  updateTenant(tenantId, { settings });

  console.log(`[channels:${tenantId}] Channel config updated`);

  res.json({
    ok: true,
    channels: redactChannelConfig(channelConfig),
    webhookUrl: `${process.env.BASE_URL || `https://${req.get("host")}`}/api/webhooks/meta/${tenantId}`,
  });
});

/**
 * Redact access tokens in channel config for safe display.
 * Shows only last 4 characters of tokens.
 */
function redactChannelConfig(config: MetaChannelConfig): any {
  const redact = (token: string | undefined) =>
    token ? `****${token.slice(-4)}` : undefined;

  const result: any = {};

  if (config.whatsapp) {
    result.whatsapp = {
      phoneNumberId: config.whatsapp.phoneNumberId,
      accessToken: redact(config.whatsapp.accessToken),
      verifyToken: config.whatsapp.verifyToken, // verify tokens are not secret
    };
  }

  if (config.messenger) {
    result.messenger = {
      pageId: config.messenger.pageId,
      pageAccessToken: redact(config.messenger.pageAccessToken),
      verifyToken: config.messenger.verifyToken,
    };
  }

  if (config.instagram) {
    result.instagram = {
      accountId: config.instagram.accountId,
      pageAccessToken: redact(config.instagram.pageAccessToken),
      verifyToken: config.instagram.verifyToken,
    };
  }

  return result;
}

// Static assets
app.use(express.static(resolve(__dirname, "../public")));

// Start server
app.listen(port, "0.0.0.0", () => {
  console.log(`[multi-tenant] Server ready on port ${port}`);
  console.log(`  Dashboard: http://localhost:${port}/dashboard`);
  console.log(`  API: http://localhost:${port}/api`);
});
