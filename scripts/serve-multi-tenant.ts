/**
 * Multi-tenant server — serves multiple website-context tenants from a single process.
 *
 * Required env vars:
 *   OPENROUTER_API_KEY — for LLM inference
 *
 * Optional env vars:
 *   PORT — server port (default: 3211)
 *   BGE_URL — full base URL of the BGE embedding service (e.g. https://bge-embed.<acct>.workers.dev); takes precedence
 *   BGE_HOST — BGE embedding server host (plain http)
 *   BGE_PORT — BGE embedding server port
 */

import { resolve, dirname, sep } from "path";
import { fileURLToPath } from "url";
import { readFile, writeFile, appendFile } from "fs/promises";
import { loadCfToken } from "../src/storage/cf-auth.js";
import { CloudflareVectorizeStore } from "../src/embeddings/vectorize-store.js";
import { BGEEmbeddingProvider, bgeBaseUrl } from "../src/embeddings/bge-provider.js";
import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import express from "express";
import cors from "cors";
import { recordEvent, getEmailForTenant, getTemplateStats, getCountryBreakdown, getIndustryBreakdown, getFunnel, getDailyStats, recordEmailEvent, assignVariant, recordExperimentEvent, getExperimentResults, getConversationSummary, getConversation } from "../src/analytics/d1.js";
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
import { randomBytes, createHmac, timingSafeEqual } from "crypto";
import {
  runMigrations,
  createTenant,
  ensureTenant,
  getTenant,
  getTenantByDomain,
  updateTenant,
  listTenants,
  hydrateRegistry,
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
import { analyzeRecordedFlow } from "../src/flows/analyzer.js";
import { OpenRouterProvider } from "../src/llm/openrouter-provider.js";
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
import { attachVoiceRelayWS } from "../src/voice/conversation-relay.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.PORT || "3211");
// Admin secret: env-only. The old committed default ("whisp-admin-2026") is public
// (it's in git history + client scripts), so it is explicitly rejected. When the secret
// is missing/weak/default we FAIL CLOSED (every admin route 403s) rather than crash the
// process — a boot crash would silently keep the previous deploy live (deploy-awareness).
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ADMIN_SECRET_OK = ADMIN_SECRET.length >= 24 && ADMIN_SECRET !== "whisp-admin-2026";
if (!ADMIN_SECRET_OK) {
  console.error("[SECURITY] ADMIN_SECRET is unset/weak/default — ALL /api/admin/* routes are DISABLED (fail-closed). Set a strong (>=24 char) ADMIN_SECRET env var.");
}

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY environment variable is required");
  process.exit(1);
}

const LOG_RING: { ts: string; level: string; msg: string }[] = [];
const LOG_MAX = 500;

const DATA_DIR = resolve(__dirname, "../data");
const DEMO_VISITS_PATH = resolve(DATA_DIR, "demo-visits.json");
const DEMO_VISITS_MAX = 2000;
let DEMO_VISITS: { ts: string; tenantId: string; domain: string; ip: string; ref: string; ua: string }[] = [];
try { DEMO_VISITS = JSON.parse(require("fs").readFileSync(DEMO_VISITS_PATH, "utf-8")); } catch {}

let demoVisitsDirty = false;
setInterval(async () => {
  if (!demoVisitsDirty) return;
  demoVisitsDirty = false;
  await writeFile(DEMO_VISITS_PATH, JSON.stringify(DEMO_VISITS, null, 2)).catch(() => {});
}, 5000);
function pushLog(level: string, msg: string) {
  LOG_RING.push({ ts: new Date().toISOString(), level, msg });
  if (LOG_RING.length > LOG_MAX) LOG_RING.shift();
}
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
console.log = (...args: unknown[]) => { pushLog("info", args.map(String).join(" ")); origLog(...args); };
console.error = (...args: unknown[]) => { pushLog("error", args.map(String).join(" ")); origErr(...args); };
console.warn = (...args: unknown[]) => { pushLog("warn", args.map(String).join(" ")); origWarn(...args); };

// Initialize database
runMigrations();
console.log("[multi-tenant] Database initialized");

// Load the Cloudflare API token (D1/Vectorize/R2 auth) and hydrate the tenant
// registry cache from D1 (source of truth) BEFORE any service uses the registry —
// the worker's recoverStuckJobs() reads listTenants(). Registry reads are then
// synchronous off this cache (refreshed every 60s).
await loadCfToken();
const hydratedCount = await hydrateRegistry();
console.log(`[multi-tenant] Registry hydrated from D1: ${hydratedCount} tenants`);

// Initialize services
const worker = new ScrapeWorker();
worker.recoverStuckJobs();
const tenantManager = new TenantManager();
const channelSessions = new ChannelSessionStore();

// Express app
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
// Twilio webhooks POST application/x-www-form-urlencoded bodies — needed for /api/voice/* routes.
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
// Baseline security headers (safe for the cross-origin widget — no framing/CSP changes here).
// strict-origin-when-cross-origin stops the admin ?secret= query string leaking via Referer.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

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

// Per-IP backstop. The session limiter above is keyed on a client-supplied,
// per-pageload-random sessionId, so a scripted client can mint unlimited sessions
// and drain shared OpenRouter credits (402-ing every prospect's demo). This caps by
// IP too. Limits are deliberately generous (3x the session limit) so a real
// conversation — even several people behind one office/carrier NAT — never trips it;
// only sustained scripted abuse does.
const ipChatRateMap = new Map<string, { mc: number; ms: number; hc: number; hs: number }>();
function checkIpChatRate(ip: string): { ok: boolean; retry?: number } {
  const now = Date.now();
  let e = ipChatRateMap.get(ip);
  if (!e) { e = { mc: 0, ms: now, hc: 0, hs: now }; ipChatRateMap.set(ip, e); }
  if (now - e.ms > 60000) { e.mc = 0; e.ms = now; }
  if (now - e.hs > 3600000) { e.hc = 0; e.hs = now; }
  if (e.mc >= 60) return { ok: false, retry: Math.ceil((e.ms + 60000 - now) / 1000) };
  if (e.hc >= 600) return { ok: false, retry: Math.ceil((e.hs + 3600000 - now) / 1000) };
  e.mc++; e.hc++;
  return { ok: true };
}

// Cleanup stale rate limit entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of signupRateMap) if (now > e.resetAt) signupRateMap.delete(k);
  for (const [k, e] of chatRateMap) if (now - e.hs > 3600000) chatRateMap.delete(k);
  for (const [k, e] of ipChatRateMap) if (now - e.hs > 3600000) ipChatRateMap.delete(k);
}, 600000);

// --- Auth middleware ---
async function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = authHeader.slice(7);
  let tenantId: string | null = null;
  try { tenantId = await validateSession(token); } catch { tenantId = null; }
  if (!tenantId) {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  (req as any).tenantId = tenantId;
  next();
}

// --- Security helpers ---
// Constant-time string compare (avoids leaking secret length/prefix via timing).
function safeStrEq(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Admin authorization. Prefers the X-Admin-Secret header (or Authorization: Bearer);
// the ?secret= query param is accepted as a deprecated fallback for existing clients
// (it leaks into access logs — migrate callers to the header, then drop query support).
// Fails closed when ADMIN_SECRET is unset/weak/default.
function adminOk(req: express.Request): boolean {
  if (!ADMIN_SECRET_OK) return false;
  const provided =
    (req.get("x-admin-secret") || "").trim() ||
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() ||
    ((req.query.secret as string) || "").trim();
  return !!provided && safeStrEq(provided, ADMIN_SECRET);
}

// Map a user-supplied tenant id to a safe directory strictly inside DATA_DIR.
// Returns null on any traversal/charset violation. Used by file read/write routes.
function safeTenantDir(rawId: unknown): { id: string; dir: string } | null {
  const id = String(rawId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return null;
  const dir = resolve(DATA_DIR, id);
  if (dir !== DATA_DIR && !dir.startsWith(DATA_DIR + sep)) return null;
  return { id, dir };
}

// Per-account auth attempt throttle (brute-force protection). Keyed on the target
// account (email / tenantId), NOT the proxy IP — so it can't be defeated by IP rotation
// and can't be abused to lock every user out at once via a shared proxy address.
const authAttemptMap = new Map<string, { count: number; resetAt: number }>();
function checkAuthAttempt(key: string): boolean {
  const now = Date.now();
  let e = authAttemptMap.get(key);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + 15 * 60 * 1000 }; authAttemptMap.set(key, e); }
  if (e.count >= 10) return false;
  e.count++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, e] of authAttemptMap) if (now > e.resetAt) authAttemptMap.delete(k); }, 600000);

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

// Claim page — "Your website already has a chatbot"
app.get("/claim", (_, res) => {
  res.sendFile(resolve(__dirname, "../public/claim/index.html"));
});

// Pricing page
app.get("/pricing", (_, res) => {
  res.sendFile(resolve(__dirname, "../public/pricing.html"));
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

// Tenant screenshot (for demo background) - local disk, then R2
app.get("/api/screenshot/:tenantId", async (req, res) => {
  // Charset-sanitize first: strips '.' and '/', which closes both the local sendFile
  // traversal and the R2-key traversal (cross-tenant object read) on this public route.
  const tid = (req.params.tenantId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!tid) { res.status(404).json({ error: "No screenshot available" }); return; }
  // Prefer the compressed .jpg (~250KB), fall back to legacy .png (~3.7MB). The browser
  // cache header means repeat demo views don't re-download the image at all.
  const VARIANTS = [["screenshot.jpg", "image/jpeg"], ["screenshot.png", "image/png"]] as const;
  const cache = "public, max-age=86400, immutable";
  // Try local disk first
  for (const id of [tid, tid.replace(/-/g, "_"), tid.replace(/_/g, "-")]) {
    for (const [file, type] of VARIANTS) {
      const p = resolve(__dirname, `../data/${id}/${file}`);
      if (existsSync(p)) { res.set("Cache-Control", cache); res.type(type); res.sendFile(p); return; }
    }
  }
  // Stream from R2 — do NOT cache to local disk. Screenshots fill the small persistent
  // disk, which makes the SQLite registry fail to write (SQLITE_FULL) and silently
  // breaks new tenant registration -> dead demos. R2 is the source of truth.
  try {
    const { downloadTenantFileStrict } = await import("../src/storage/r2.js");
    for (const [file, type] of VARIANTS) {
      const data = await downloadTenantFileStrict(tid, file)
        || await downloadTenantFileStrict(tid.replace(/-/g, "_"), file);
      if (data) { res.set("Cache-Control", cache); res.type(type).send(data); return; }
    }
    // Cleanly absent (not an R2 error) — genuine 404.
    res.status(404).json({ error: "No screenshot available" });
  } catch (e: any) {
    // R2 auth/network/throttle error — distinct from a missing image so monitoring
    // can tell an outage apart from "this tenant has no screenshot".
    console.error(`[screenshot] R2 error for ${tid}: ${e?.message || e}`);
    res.status(500).json({ error: "screenshot_backend_unavailable" });
  }
});

// Personalized landing page — showcases the AI assistant for a prospect
app.get("/for/:tenantId", async (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  if (!tenant || tenant.status !== "active") {
    res.status(404).send("Not ready yet.");
    return;
  }

  const host = req.get("host") || "whisp.so";
  const baseUrl = process.env.BASE_URL || "https://" + host;
  const brand = tenant.brandName || tenant.domain;
  const demoUrl = `${baseUrl}/demo/${tenant.id}`;
  const screenshotUrl = `${baseUrl}/api/screenshot/${tenant.id}`;

  // Generate sample Q&As on the fly
  const questions = [
    "What do you do?",
    "How can I contact you?",
    "Where are you located?",
  ];

  const qas: { q: string; a: string }[] = [];
  const chat = await tenantManager.getChatForTenant(tenant.id);
  for (const q of questions) {
    try {
      const resp = await chat.chat([{ role: "user", content: q }], `landing_${tenant.id}_${Date.now()}`);
      // Skip ungrounded answers — never freeze a hallucination/fallback about the
      // prospect's own business into their static showcase page.
      if (resp.grounded === false || !resp.message || !resp.message.trim()) continue;
      qas.push({ q, a: resp.message.slice(0, 300) + (resp.message.length > 300 ? "..." : "") });
    } catch {
      // skip failed questions
    }
  }

  // If nothing came back grounded, the demo isn't really ready — don't render a
  // hollow showcase. (The background sweep will also have demoted it to 'broken'.)
  if (qas.length === 0) {
    res.status(404).send("Not ready yet.");
    return;
  }

  // Escape LLM output before the bold/newline transforms so an answer containing
  // HTML/script can't inject into the page.
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const qaHtml = qas.map(({ q, a }) => `
    <div class="qa">
      <div class="qa-q">${esc(q)}</div>
      <div class="qa-a">${esc(a).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>")}</div>
    </div>
  `).join("");

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Assistant for ${brand}</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Archivo:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:"Archivo",sans-serif; background:#0a0e1a; color:#f1f5f9; min-height:100vh; }
.container { max-width:720px; margin:0 auto; padding:40px 24px 80px; }
.badge { display:inline-block; font-size:11px; font-weight:600; color:#3b82f6; background:rgba(59,130,246,0.1); border:1px solid rgba(59,130,246,0.2); padding:4px 12px; border-radius:10px; margin-bottom:24px; }
h1 { font-family:"DM Serif Display",serif; font-size:clamp(28px,4vw,40px); line-height:1.2; margin-bottom:12px; }
h1 em { color:#3b82f6; font-style:italic; }
.sub { color:#94a3b8; font-size:16px; line-height:1.6; margin-bottom:40px; }
.screenshot-wrap { border-radius:16px; overflow:hidden; border:1px solid rgba(255,255,255,0.08); margin-bottom:48px; position:relative; }
.screenshot-wrap img { width:100%; display:block; }
.screenshot-overlay { position:absolute; inset:0; background:linear-gradient(transparent 60%, #0a0e1a 100%); }
.section-label { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.1em; color:#64748b; margin-bottom:20px; }
.qa { margin-bottom:24px; }
.qa-q { font-size:14px; font-weight:600; color:#3b82f6; margin-bottom:8px; padding-left:16px; border-left:2px solid #3b82f6; }
.qa-a { font-size:14px; color:#cbd5e1; line-height:1.7; padding-left:16px; }
.cta-section { text-align:center; margin-top:48px; padding-top:40px; border-top:1px solid rgba(255,255,255,0.06); }
.cta-section h2 { font-family:"DM Serif Display",serif; font-size:24px; margin-bottom:12px; }
.cta-section p { color:#94a3b8; font-size:15px; margin-bottom:28px; }
.cta-btn { display:inline-block; background:#3b82f6; color:#fff; font-size:15px; font-weight:700; padding:14px 32px; border-radius:12px; text-decoration:none; transition:all 0.2s; }
.cta-btn:hover { background:#2563eb; transform:translateY(-1px); box-shadow:0 4px 16px rgba(59,130,246,0.3); }
.note { color:#64748b; font-size:13px; margin-top:16px; }
.footer { text-align:center; margin-top:48px; color:#334155; font-size:12px; }
.footer a { color:#475569; }
</style>
</head>
<body>
<div class="container">
  <div class="badge">Whisp AI</div>
  <h1>I built an AI assistant<br>for <em>${brand}</em></h1>
  <p class="sub">It read your entire website and can answer visitor questions 24/7 - services, pricing, contact info, anything on your site.</p>

  <div class="screenshot-wrap">
    <img src="${screenshotUrl}" alt="${brand}" decoding="async" fetchpriority="high">
    <div class="screenshot-overlay"></div>
  </div>

  <div class="section-label">Here's what it knows</div>
  ${qaHtml}

  <div class="cta-section">
    <h2>Try it yourself</h2>
    <p>Ask it anything about ${brand} - it already knows your website.</p>
    <a class="cta-btn" href="${demoUrl}">Open the AI assistant</a>
    <p class="note">Free - no signup, no credit card. One line of code to add to your site.</p>
  </div>

  <div class="footer">
    <p>Jakub - <a href="https://whisp.so">whisp.so</a></p>
  </div>
</div>
</body>
</html>`);
});

// Demo page — standalone chat for a tenant (no embed needed)
// Self-heal: a tenant can be missing from Render's registry even though it was
// scraped (vectors in Vectorize, files in R2) — e.g. the VPS outreach scraped +
// emailed it but the Render registration call failed (a restart/blip). R2 is the
// source of truth for scraped data, so if context-meta.json exists there we
// recreate the registry row on demand and the demo/chat just works.
async function reconcileTenantFromR2(requestedId: string): Promise<any | null> {
  try {
    const { downloadTenantFile } = await import("../src/storage/r2.js");
    let buf = await downloadTenantFile(requestedId, "context-meta.json");
    if (!buf) buf = await downloadTenantFile(requestedId.replace(/-/g, "_"), "context-meta.json");
    if (!buf) return null;
    const meta = JSON.parse(buf.toString());
    const id: string = meta.tenantId || requestedId;
    const siteUrl: string = meta.siteUrl || `https://${id.replace(/_/g, ".")}`;
    let domain: string;
    try { domain = new URL(siteUrl).hostname; } catch { domain = id.replace(/_/g, "."); }
    const t = ensureTenant(id, `info@${domain}`, domain, siteUrl);
    if (t) {
      // Don't trust meta.chunksCount (it can be stale/optimistic) — a tenant must
      // not self-heal to 'active' unless its vectors are actually queryable now.
      let queryable = false;
      try { queryable = await new CloudflareVectorizeStore({ tenantId: id }).hasVectors(); } catch { /* treat as not queryable */ }
      updateTenant(t.id, { status: queryable ? "active" : "broken", chunksCount: meta.chunksCount || 0, pagesCount: meta.pagesCount || 0, lastScrapedAt: meta.lastScrapedAt || null });
      console.log(`[self-heal] reconciled tenant ${t.id} from R2 -> ${queryable ? "active" : "broken (0 queryable vectors)"}`);
      return getTenant(t.id);
    }
    return t;
  } catch (e: any) {
    console.error(`[self-heal] ${requestedId} failed: ${e?.message || e}`);
    return null;
  }
}

// Self-serve onboarding page shown when a demo isn't live yet: lets the visitor claim the
// site (we scrape it on demand) and get emailed when their assistant is ready.
function buildOnboardPage(opts: { siteUrl: string; brand: string; state: "onboard" | "building"; baseUrl: string; tenantId?: string }): string {
  const safeBrand = (opts.brand || "this website").replace(/[<>]/g, "");
  const safeUrl = (opts.siteUrl || "").replace(/"/g, "&quot;");
  const safeTid = (opts.tenantId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const building = opts.state === "building";
  const body = building
    ? `<div class="ok"><div class="spinner"></div>
        <h1>Building ${safeBrand}'s assistant...</h1>
        <p class="sub">We're reading the website and training the AI live - this page updates itself. Usually about 90 seconds. We'll also email you the link.</p>
        <div class="prog-wrap">
          <div class="prog-bar"><div class="prog-fill" id="prog-fill"></div></div>
          <div class="pstep" id="ps1"><span class="pdot"></span><span>Queued</span></div>
          <div class="pstep" id="ps2"><span class="pdot"></span><span>Reading &amp; indexing the website</span></div>
          <div class="pstep" id="ps3"><span class="pdot"></span><span>Assistant ready</span></div>
        </div>
        <div id="perr"></div></div>`
    : `<div class="badge">Whisp AI</div>
        <h1>${safeBrand} doesn't have an AI assistant yet</h1>
        <p class="sub">We'll read the entire website and build a chat assistant that answers visitor questions 24/7 - a free, working preview in a few minutes.</p>
        <div id="err"></div>
        <label>Website</label>
        <input id="url" type="text" inputmode="url" autocapitalize="none" spellcheck="false" value="${safeUrl}" placeholder="example.com" />
        <label>Your email (we'll notify you when it's ready)</label>
        <input id="email" type="email" placeholder="you@company.com" />
        <button id="go" type="button">Build my AI assistant</button>
        <p class="fine">Free preview. We only read public pages. No card required.</p>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeBrand} - AI assistant</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0a0e1a;color:#e7e9ee;font-family:'Archivo',-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:480px;background:rgba(22,24,34,0.92);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px 36px;box-shadow:0 8px 32px rgba(0,0,0,0.35)}
.badge{display:inline-block;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#60a5fa;margin-bottom:18px}
h1{font-family:'DM Serif Display',Georgia,serif;font-weight:400;font-size:27px;line-height:1.25;margin:0 0 12px}
p.sub{font-size:15px;color:#9aa3b2;line-height:1.6;margin:0 0 26px}
label{display:block;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#7b8494;margin:0 0 7px}
input{width:100%;padding:13px 15px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);color:#f1f5f9;font-family:inherit;font-size:15px;margin-bottom:18px}
input::placeholder{color:#64748b}
input:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,0.5)}
button{width:100%;padding:15px;border:none;border-radius:10px;background:#3b82f6;color:#fff;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;transition:all 0.15s ease}
button:hover{background:#2563eb;transform:translateY(-1px)}button:disabled{opacity:0.6;cursor:default;transform:none}
.fine{font-size:12px;color:#5b6472;margin-top:16px;line-height:1.5}
.ok{text-align:center}
.spinner{width:34px;height:34px;border:3px solid rgba(255,255,255,0.15);border-top-color:#3b82f6;border-radius:50%;animation:spin 0.9s linear infinite;margin:0 auto 22px}
@keyframes spin{to{transform:rotate(360deg)}}
#err{color:#f87171;font-size:13px;margin:0 0 14px;display:none}
.prog-wrap{margin:22px 0 4px;text-align:left}
.prog-bar{height:6px;background:rgba(255,255,255,0.08);border-radius:999px;overflow:hidden;margin-bottom:16px}
.prog-fill{height:100%;width:2%;border-radius:999px;background:linear-gradient(90deg,#3b82f6,#60a5fa);transition:width 0.6s ease}
.pstep{display:flex;align-items:center;gap:10px;font-size:13.5px;color:#5b6472;padding:5px 0}
.pstep .pdot{width:9px;height:9px;border-radius:999px;background:rgba(255,255,255,0.15);flex:none;transition:background 0.3s ease}
.pstep.on{color:#e7e9ee}
.pstep.on .pdot{background:#3b82f6;animation:pulse-dot 1.6s ease infinite}
.pstep.done{color:#9aa3b2}
.pstep.done .pdot{background:#10b981;animation:none}
@keyframes pulse-dot{0%,100%{box-shadow:0 0 0 3px rgba(59,130,246,0.25)}50%{box-shadow:0 0 0 7px rgba(59,130,246,0.05)}}
#perr{color:#f87171;font-size:13px;margin-top:14px;display:none;text-align:center}
</style></head>
<body><div class="card" id="card">${body}</div>
<script>
(function(){
  var go=document.getElementById('go'); if(!go) return;
  go.addEventListener('click', function(){
    var url=document.getElementById('url').value.trim(), email=document.getElementById('email').value.trim();
    var err=document.getElementById('err'); err.style.display='none';
    if(url && !/^https?:\\/\\//i.test(url)) url='https://'+url;
    if(!url || !email){ err.textContent='Please enter your website and email.'; err.style.display='block'; return; }
    go.disabled=true; go.textContent='Starting...';
    fetch('${opts.baseUrl}/api/onboard-demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({siteUrl:url,email:email})})
      .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})
      .then(function(res){
        if(res.ok && res.d && res.d.tenantId){ location.href='${opts.baseUrl}/demo/'+res.d.tenantId; return; }
        if(res.ok){ document.getElementById('card').innerHTML='<div class="ok"><div class="spinner"></div><h1>On it!</h1><p class="sub" style="margin-bottom:0">We are building your assistant now. We will email <strong style="color:#f1f5f9">'+email+'</strong> the moment it is ready - usually a few minutes.</p></div>'; }
        else { err.textContent=(res.d && res.d.error) || 'Something went wrong. Please try again.'; err.style.display='block'; go.disabled=false; go.textContent='Build my AI assistant'; }
      })
      .catch(function(){ err.textContent='Network error. Please try again.'; err.style.display='block'; go.disabled=false; go.textContent='Build my AI assistant'; });
  });
})();
(function(){
  var tid='${safeTid}'; if(!tid || !document.getElementById('prog-fill')) return;
  var fill=document.getElementById('prog-fill');
  var steps=[document.getElementById('ps1'),document.getElementById('ps2'),document.getElementById('ps3')];
  var perr=document.getElementById('perr');
  var t0=Date.now(); var done=false;
  function setStep(n){ for(var i=0;i<3;i++){ steps[i].className='pstep'+(i<n-1?' done':(i===n-1?' on':'')); } }
  setStep(1);
  var barTimer=setInterval(function(){
    if(done) return;
    var el=(Date.now()-t0)/1000;
    var pct=Math.min(92, 100*(1-Math.exp(-el/40)));
    fill.style.width=pct.toFixed(1)+'%';
  },600);
  function poll(){
    if(done) return;
    fetch('${opts.baseUrl}/api/tenants/'+tid+'/status')
      .then(function(r){return r.json();})
      .then(function(s){
        if(s.status==='active'){
          done=true; clearInterval(barTimer); fill.style.width='100%';
          for(var i=0;i<3;i++) steps[i].className='pstep done';
          setTimeout(function(){ location.href='${opts.baseUrl}/demo/'+tid; }, 900);
          return;
        }
        if(s.status==='error'){
          done=true; clearInterval(barTimer);
          perr.textContent='Something went wrong while reading the site. Please try again in a few minutes.';
          perr.style.display='block';
          return;
        }
        setStep(s.status==='scraping' ? 2 : 1);
        setTimeout(poll, 2500);
      })
      .catch(function(){ setTimeout(poll, 4000); });
  }
  setTimeout(poll, 1500);
})();
</script></body></html>`;
}

app.get("/demo/:tenantId", async (req, res) => {
  let tenant = getTenant(req.params.tenantId);
  // Fallback: if not found, try all tenants matching this domain pattern
  // Handles underscore/hyphen mismatch from old VPS outreach
  if (!tenant) {
    const allTenants = listTenants();
    const normalized = req.params.tenantId.replace(/[-_]/g, "").toLowerCase();
    tenant = allTenants.find((t: any) => t.id.replace(/[-_]/g, "").toLowerCase() === normalized) || null;
    if (tenant) {
      res.redirect(301, `/demo/${tenant.id}`);
      return;
    }
  }
  if (!tenant) tenant = await reconcileTenantFromR2(req.params.tenantId);
  if (!tenant || tenant.status !== "active") {
    // Not live yet -> self-serve onboarding. If it's already being built (queued/scraping),
    // show the in-progress state; otherwise offer to claim + scrape it on demand.
    const reqId = req.params.tenantId;
    const obHost = req.get("host") || "whisp.so";
    const obBase = process.env.BASE_URL || "https://" + obHost;
    const building = !!tenant && ["pending", "queued", "scraping"].includes(tenant.status);
    const guessUrl = (tenant && tenant.siteUrl) || ("https://" + reqId.replace(/_/g, "."));
    const guessBrand = (tenant && (tenant.brandName || tenant.domain)) || reqId.replace(/_/g, ".");
    res.status(building ? 200 : 404).send(buildOnboardPage({ siteUrl: guessUrl, brand: guessBrand, state: building ? "building" : "onboard", baseUrl: obBase, tenantId: tenant ? tenant.id : "" }));
    return;
  }
  const isReady = true;

  DEMO_VISITS.push({
    ts: new Date().toISOString(),
    tenantId: tenant.id,
    domain: tenant.domain,
    ip: (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim(),
    ref: (req.headers["referer"] || req.headers["referrer"] || "") as string,
    ua: (req.headers["user-agent"] || "").slice(0, 120),
  });
  if (DEMO_VISITS.length > DEMO_VISITS_MAX) DEMO_VISITS.shift();
  demoVisitsDirty = true;
  console.log(`[demo-visit] ${tenant.domain} from ${(req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim()}`);
  const visitIp = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
  // Filter scanner IPs (AWS, Azure, Google Cloud) and internal IPs
  const isScanner = /^(18\.|52\.|54\.|35\.|4\.|13\.|34\.|20\.|40\.|48\.|72\.14[45]|85\.210|135\.225|155\.117|164\.132|172\.186|217\.182)/.test(visitIp);
  const isInternal = !!req.headers["x-whisp-probe"] || (req.query as any)?.probe === "1" || visitIp === "79.184.118.71" || visitIp === "176.9.1.133" || visitIp.startsWith("127.");
  if (!isScanner && !isInternal) {
    getEmailForTenant(tenant.id).then(email => {
      if (email) recordEvent(email, "demo_visit", { ip: visitIp });
    }).catch(() => {});
  }

  // Always use HTTPS in production (Render terminates TLS at the proxy)
  const host = req.get("host") || "website-context-dwoj.onrender.com";
  const baseUrl = process.env.BASE_URL || "https://" + host;
  const brand = tenant.brandName || tenant.domain;

  // A/B experiment: widget start state
  const visitorIp = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
  const visitorId = `${visitorIp}_${tenant.id}`;
  let startExpanded = true;
  try {
    const variant = await assignVariant("widget-start-state", visitorId, tenant.id);
    startExpanded = variant === "expanded";
  } catch {}
  // Explicit override (handy for previewing a specific state): ?collapsed=1 / ?expanded=1
  if (req.query.collapsed === "1" || req.query.bar === "1") startExpanded = false;
  if (req.query.expanded === "1") startExpanded = true;

  res.send('<!DOCTYPE html>\
<html lang="en">\
<head>\
<meta charset="UTF-8">\
<meta name="viewport" content="width=device-width, initial-scale=1.0">\
<title>' + brand + ' - AI assistant by Whisp</title>\
<link rel="icon" type="image/svg+xml" href="/logo.svg">\
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Archivo:wght@400;500;600;700&display=swap" rel="stylesheet">\
<style>\
* { margin:0; padding:0; box-sizing:border-box; }\
html, body { height:100%; }\
body {\
  font-family:"Archivo",system-ui,sans-serif; color:#f1f5f9;\
  background-color:#0a0e1a;\
  background-image:radial-gradient(ellipse 70% 55% at 50% -12%, rgba(59,130,246,0.14), transparent 60%), radial-gradient(ellipse 45% 40% at 88% 105%, rgba(59,130,246,0.07), transparent 60%);\
  height:100vh; height:100dvh; overflow:hidden;\
  display:flex; flex-direction:column;\
}\
.demo-header {\
  flex:none; position:relative; z-index:60;\
  display:flex; align-items:center; gap:14px; padding:13px 24px;\
  background:rgba(10,14,26,0.75); border-bottom:1px solid rgba(255,255,255,0.08);\
  backdrop-filter:blur(20px) saturate(1.4); -webkit-backdrop-filter:blur(20px) saturate(1.4);\
  animation:fadeDown 0.5s ease 0.1s both;\
}\
@keyframes fadeDown { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }\
.demo-brand { display:flex; align-items:center; gap:10px; min-width:0; }\
.demo-mark { width:26px; height:26px; flex:none; }\
.demo-name { font-size:14px; font-weight:700; color:#f1f5f9; letter-spacing:-0.01em; }\
.demo-badge { font-size:10px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; color:#3b82f6; background:rgba(59,130,246,0.1); border:1px solid rgba(59,130,246,0.25); padding:4px 10px; border-radius:999px; white-space:nowrap; }\
.demo-domain {\
  margin-left:auto; font-size:13px; color:#94a3b8;\
  background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1);\
  padding:7px 16px; border-radius:999px; max-width:320px;\
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;\
}\
.demo-cta {\
  flex:none; display:inline-flex; align-items:center; justify-content:center;\
  min-height:40px; padding:9px 18px; background:#3b82f6; color:#fff; border:none; border-radius:10px;\
  font-family:inherit; font-size:13px; font-weight:600; cursor:pointer; text-decoration:none;\
  transition:all 0.15s ease; white-space:nowrap;\
}\
.demo-cta:hover { background:#2563eb; transform:translateY(-1px); box-shadow:0 4px 16px rgba(59,130,246,0.35); }\
.demo-body {\
  flex:1; min-height:0; position:relative; z-index:1;\
}\
.demo-bg { position:absolute; inset:0; z-index:0; background:#0d1322; animation:bgIn 0.8s ease 0.15s both; }\
@keyframes bgIn { from{opacity:0} to{opacity:1} }\
.demo-bg img { width:100%; height:100%; object-fit:cover; object-position:top; display:block; }\
.demo-fade {\
  position:absolute; left:0; right:0; bottom:0; height:32%; z-index:1; pointer-events:none;\
  background:linear-gradient(transparent, rgba(10,14,26,0.88));\
}\
.demo-bg-fallback {\
  position:absolute; inset:0; display:flex; align-items:center; justify-content:center;\
  background:linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);\
}\
.demo-bg-fallback .domain {\
  font-family:"DM Serif Display",serif; font-size:clamp(28px,5vw,48px); color:rgba(255,255,255,0.08);\
  letter-spacing:0.02em;\
}\
.demo-info {\
  position:fixed; bottom:108px; left:50%; transform:translateX(-50%);\
  background:rgba(17,24,39,0.88); border:1px solid rgba(255,255,255,0.1); border-radius:16px; padding:22px 28px;\
  backdrop-filter:blur(24px) saturate(1.4); -webkit-backdrop-filter:blur(24px) saturate(1.4);\
  box-shadow:0 8px 32px rgba(0,0,0,0.35); z-index:10; text-align:center;\
  max-width:380px; width:calc(100% - 40px); animation: fadeUp 0.5s ease 1s both;\
}\
@keyframes fadeUp { from{opacity:0;transform:translateX(-50%) translateY(10px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }\
.demo-info .tag { display:inline-block; font-size:10px; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; color:#3b82f6; margin-bottom:8px; }\
.demo-info h3 { font-family:"DM Serif Display",serif; font-weight:400; font-size:21px; margin-bottom:6px; color:#f1f5f9; }\
.demo-info p { font-size:14px; color:#94a3b8; line-height:1.6; margin-bottom:14px; }\
.demo-info p strong { color:#f1f5f9; font-weight:600; }\
.demo-info .arrow { font-size:18px; color:#3b82f6; animation:bounce 1.5s ease infinite; margin-bottom:4px; }\
@keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(6px)} }\
.demo-dismiss { font-size:12px; color:#64748b; cursor:pointer; border:none; background:none; font-family:inherit; padding:6px 10px; }\
.demo-dismiss:hover { color:#f1f5f9; }\
.scroll-modal {\
  display:none; position:fixed; inset:0; z-index:100000;\
  background:rgba(0,0,0,0.7); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);\
  align-items:center; justify-content:center;\
}\
.scroll-modal.show { display:flex; }\
/* Entrance for the FLEX-CENTERED box. It must NOT reuse the demo-info fadeUp keyframe:\
   that ends on transform:translateX(-50%) (correct for demo-info, which is left:50%),\
   but here the box is already centered by the parent flexbox, so translateX(-50%)\
   shoved it half its width off-center -> off-screen on mobile. Translate Y only. */\
@keyframes scrollModalIn { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }\
.scroll-modal-box {\
  background:#111827; border:1px solid rgba(255,255,255,0.08); border-radius:16px;\
  padding:36px 32px; max-width:400px; width:calc(100% - 32px); text-align:center;\
  box-shadow:0 8px 32px rgba(0,0,0,0.35);\
  animation:scrollModalIn 0.3s ease both;\
}\
.scroll-modal-box h3 { font-family:"DM Serif Display",serif; font-weight:400; font-size:22px; color:#f1f5f9; margin-bottom:10px; }\
.scroll-modal-box p { font-size:14px; color:#94a3b8; line-height:1.6; margin-bottom:24px; }\
.scroll-modal-box p strong { color:#f1f5f9; font-weight:600; }\
.scroll-modal-cta {\
  display:inline-block; background:#3b82f6; color:#fff; font-size:14px; font-weight:600;\
  padding:13px 28px; border-radius:10px; text-decoration:none; transition:all 0.15s ease;\
}\
.scroll-modal-cta:hover { background:#2563eb; transform:translateY(-1px); box-shadow:0 4px 16px rgba(59,130,246,0.35); }\
.scroll-modal-close {\
  display:block; margin:14px auto 0; font-size:12px; color:#64748b; cursor:pointer;\
  border:none; background:none; font-family:inherit; padding:6px 10px;\
}\
.scroll-modal-close:hover { color:#f1f5f9; }\
@media(max-width:640px) {\
  .demo-header { padding:10px 14px; gap:10px; }\
  .demo-domain { display:none; }\
  .demo-badge { display:none; }\
  .demo-cta { margin-left:auto; min-height:44px; padding:10px 14px; font-size:12px; }\
  .demo-info { bottom:96px; padding:18px 20px; }\
}\
</style>\
</head>\
<body>\
<header class="demo-header">\
  <div class="demo-brand">\
    <svg class="demo-mark" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill="#3b82f6"/><path d="M8.5 11.5C8.5 9.567 10.067 8 12 8h8c1.933 0 3.5 1.567 3.5 3.5v5c0 1.933-1.567 3.5-3.5 3.5h-5l-3 2.5V20H12c-1.933 0-3.5-1.567-3.5-3.5v-5z" fill="white" opacity="0.95"/><path d="M13.5 12.5c1.5-.8 3.5-.8 5 0" stroke="#3b82f6" stroke-width="1.3" stroke-linecap="round"/><path d="M14.5 15c1-.5 2.5-.5 3 0" stroke="#3b82f6" stroke-width="1.3" stroke-linecap="round"/></svg>\
    <span class="demo-name">Whisp</span>\
    <span class="demo-badge">Live demo</span>\
  </div>\
  <span class="demo-domain">' + tenant.domain + '</span>\
  <a class="demo-cta" href="/">Get this for your site</a>\
</header>\
<main class="demo-body">\
  <div class="demo-bg" id="demo-bg"></div>\
  <div class="demo-fade"></div>\
<script>\
(function(){\
  var bg=document.getElementById("demo-bg");\
  var img=document.createElement("img");\
  img.src="' + baseUrl + '/api/screenshot/' + tenant.id + '";\
  img.alt="Screenshot of ' + tenant.domain + '";\
  img.onerror=function(){bg.innerHTML=\'<div class="demo-bg-fallback"><span class="domain">' + tenant.domain + '</span></div>\';};\
  bg.appendChild(img);\
})();\
</script>\
  <div class="demo-info" id="demo-info">\
    <span class="tag">Try it out</span>\
    <h3>Ask it anything</h3>\
    <p>This AI knows everything about <strong>' + brand + '</strong>. Just start typing below to ask any question.</p>\
    <div class="arrow">↓</div>\
    <button class="demo-dismiss" onclick="document.getElementById(\'demo-info\').style.display=\'none\'">Dismiss</button>\
  </div>\
</main>\
<div class="scroll-modal" id="scroll-modal">\
  <div class="scroll-modal-box">\
    <h3>This is a preview</h3>\
    <p>You are viewing a screenshot of <strong>' + brand + '</strong> with an AI chat widget. To get this widget on your actual website, sign up below - it takes one line of code.</p>\
    <a class="scroll-modal-cta" href="/">Get Whisp for your website</a>\
    <button class="scroll-modal-close" onclick="document.getElementById(\'scroll-modal\').classList.remove(\'show\')">Close and keep chatting</button>\
  </div>\
</div>\
<script>\
(function(){\
  var shown=false;\
  var ready=false;\
  setTimeout(function(){ready=true;},10000);\
  function showModal(){\
    if(!shown && ready){\
      var el=document.getElementById("scroll-modal");\
      if(el){shown=true;el.classList.add("show");}\
    }\
  }\
  window.addEventListener("wheel",function(e){\
    if(Math.abs(e.deltaY)>50) showModal();\
  },{passive:true});\
})();\
window.__experimentVariant="' + (startExpanded ? 'expanded' : 'collapsed') + '";\
window.__visitorId=' + JSON.stringify(visitorId).replace(/</g, '\\u003c') + ';\
window.addEventListener("load", function(){\
  var c={"tenantId":"' + tenant.id + '","apiHost":"' + baseUrl + '","brandName":"' + brand.replace(/"/g, '\\"') + '","forceTheme":"dark","startExpanded":' + startExpanded + ',"demoMode":true,"experimentVariant":"' + (startExpanded ? 'expanded' : 'collapsed') + '"};\
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

// Conversational website — chat-first page for a business
app.get("/site/:tenantId", (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).send("<!DOCTYPE html><html><body style='font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#94a3b8'><p>Site not found.</p></body></html>");
    return;
  }

  const host = req.get("host") || "whisp.so";
  const baseUrl = process.env.BASE_URL || "https://" + host;
  const brand = tenant.brandName || tenant.domain;
  const settings = tenant.settings || {};
  const tagline = settings.tagline || "Ask me anything";
  const accentColor = settings.accentColor || "#3b82f6";
  const theme = settings.siteTheme || "dark";
  const bgDark = theme === "dark";

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${brand}</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html, body { height:100%; }
body {
  font-family: "Inter", system-ui, sans-serif;
  background: ${bgDark ? '#0a0e1a' : '#fafafa'};
  color: ${bgDark ? '#f1f5f9' : '#1a1a1a'};
  display: flex; flex-direction: column;
  -webkit-font-smoothing: antialiased;
}

.site-header {
  padding: 16px 24px;
  display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid ${bgDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'};
  background: ${bgDark ? 'rgba(10,14,26,0.8)' : 'rgba(255,255,255,0.8)'};
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  position: fixed; top:0; left:0; right:0; z-index: 100;
}
.site-brand {
  display: flex; align-items: center; gap: 10px;
  font-size: 16px; font-weight: 700;
}
.site-brand-dot {
  width: 10px; height: 10px; border-radius: 50%;
  background: ${accentColor};
  box-shadow: 0 0 8px ${accentColor}44;
}
.site-nav {
  display: flex; gap: 16px; align-items: center;
}
.site-nav a {
  font-size: 13px; color: ${bgDark ? '#94a3b8' : '#6b7280'};
  text-decoration: none; font-weight: 500;
  transition: color 0.2s;
}
.site-nav a:hover { color: ${bgDark ? '#f1f5f9' : '#1a1a1a'}; }

.site-hero {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  text-align: center; padding: 120px 24px 40px;
  position: relative;
}
.site-glow {
  position: absolute; top: 20%; left: 50%; transform: translateX(-50%);
  width: 600px; height: 400px;
  background: radial-gradient(ellipse, ${accentColor}15 0%, transparent 70%);
  pointer-events: none;
}
.site-title {
  font-family: "DM Serif Display", Georgia, serif;
  font-size: clamp(36px, 6vw, 64px);
  font-weight: 400; line-height: 1.1;
  letter-spacing: -0.02em;
  margin-bottom: 12px;
  position: relative;
}
.site-tagline {
  font-size: 18px;
  color: ${bgDark ? '#94a3b8' : '#6b7280'};
  margin-bottom: 40px;
  max-width: 400px;
}

.site-chat-prompt {
  width: 100%; max-width: 560px;
  position: relative;
}
.site-chat-input {
  width: 100%; padding: 18px 60px 18px 24px;
  background: ${bgDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'};
  border: 1px solid ${bgDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'};
  border-radius: 20px; outline: none;
  font-family: inherit; font-size: 16px;
  color: ${bgDark ? '#f1f5f9' : '#1a1a1a'};
  transition: border-color 0.2s, box-shadow 0.2s;
}
.site-chat-input::placeholder {
  color: ${bgDark ? '#64748b' : '#9ca3af'};
}
.site-chat-input:focus {
  border-color: ${accentColor}66;
  box-shadow: 0 0 0 4px ${accentColor}15;
}
.site-chat-send {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  width: 40px; height: 40px; border-radius: 14px;
  background: ${accentColor}; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.15s;
}
.site-chat-send:hover { transform: translateY(-50%) scale(1.05); }
.site-chat-send svg { width: 16px; height: 16px; }

.site-suggestions {
  display: flex; gap: 8px; flex-wrap: wrap;
  justify-content: center; margin-top: 16px;
  max-width: 560px;
}
.site-suggestion {
  padding: 8px 16px;
  background: ${bgDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'};
  border: 1px solid ${bgDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};
  border-radius: 12px; font-size: 13px;
  color: ${bgDark ? '#94a3b8' : '#6b7280'};
  cursor: pointer; transition: all 0.2s;
}
.site-suggestion:hover {
  background: ${bgDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};
  color: ${bgDark ? '#f1f5f9' : '#1a1a1a'};
  border-color: ${accentColor}44;
}

/* Chat messages area - appears when conversation starts */
.site-messages {
  display: none; width: 100%; max-width: 560px;
  margin: 0 auto; flex: 1;
  overflow-y: auto; padding: 16px 0;
}
.site-messages.active { display: flex; flex-direction: column; gap: 12px; }
.site-msg {
  max-width: 85%; padding: 14px 18px;
  border-radius: 18px; font-size: 15px; line-height: 1.6;
  animation: msgIn 0.3s ease;
}
@keyframes msgIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
.site-msg.user {
  align-self: flex-end;
  background: ${accentColor}; color: white;
  border-bottom-right-radius: 4px;
}
.site-msg.bot {
  align-self: flex-start;
  background: ${bgDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'};
  border: 1px solid ${bgDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};
  border-bottom-left-radius: 4px;
}
.site-msg.bot a { color: ${accentColor}; }
.site-msg.bot strong { font-weight: 600; }
.site-typing {
  display: flex; gap: 4px; padding: 14px 18px;
  align-self: flex-start;
  background: ${bgDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'};
  border-radius: 18px 18px 18px 4px;
}
.site-typing span {
  width: 6px; height: 6px; border-radius: 50%;
  background: ${bgDark ? '#64748b' : '#9ca3af'};
  animation: dotBounce 1.2s infinite;
}
.site-typing span:nth-child(2) { animation-delay: 0.2s; }
.site-typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dotBounce { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-6px)} }

/* Input bar fixed at bottom in chat mode */
.site-input-bar {
  display: none; padding: 16px 24px;
  border-top: 1px solid ${bgDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'};
  background: ${bgDark ? 'rgba(10,14,26,0.9)' : 'rgba(255,255,255,0.9)'};
  backdrop-filter: blur(20px);
}
.site-input-bar.active { display: block; }
.site-input-bar .site-chat-prompt { max-width: 560px; margin: 0 auto; }

.site-footer {
  padding: 16px 24px; text-align: center;
  font-size: 12px; color: ${bgDark ? '#475569' : '#9ca3af'};
}
.site-footer a { color: ${bgDark ? '#64748b' : '#6b7280'}; text-decoration: none; }
.site-footer a:hover { color: ${accentColor}; }

.site-powered {
  font-size: 11px; color: ${bgDark ? '#334155' : '#d1d5db'};
  margin-top: 24px;
}
.site-powered a { color: ${bgDark ? '#475569' : '#9ca3af'}; text-decoration: none; }

@media(max-width:600px) {
  .site-title { font-size: 32px; }
  .site-nav a:not(:last-child) { display: none; }
}
</style>
</head>
<body>

<header class="site-header">
  <div class="site-brand">
    <div class="site-brand-dot"></div>
    ${brand}
  </div>
  <nav class="site-nav">
    <a href="https://${tenant.domain}" target="_blank">Website</a>
  </nav>
</header>

<main class="site-hero" id="hero">
  <div class="site-glow"></div>
  <h1 class="site-title">${brand}</h1>
  <p class="site-tagline">${tagline}</p>

  <div class="site-chat-prompt" id="hero-prompt">
    <input class="site-chat-input" id="chat-input" type="text" placeholder="Ask me anything about ${brand}..." autocomplete="off" autofocus />
    <button class="site-chat-send" id="chat-send">
      <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
    </button>
  </div>

  <div class="site-suggestions" id="suggestions">
    <div class="site-suggestion">What services do you offer?</div>
    <div class="site-suggestion">What are your hours?</div>
    <div class="site-suggestion">How can I contact you?</div>
  </div>
</main>

<div class="site-messages" id="messages"></div>

<div class="site-input-bar" id="input-bar">
  <div class="site-chat-prompt">
    <input class="site-chat-input" id="chat-input-bar" type="text" placeholder="Type a message..." autocomplete="off" />
    <button class="site-chat-send" id="chat-send-bar">
      <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
    </button>
  </div>
</div>

<footer class="site-footer">
  <div class="site-powered">Powered by <a href="https://whisp.so">Whisp</a></div>
</footer>

<script>
(function() {
  var API = "${baseUrl}";
  var TENANT = "${tenant.id}";
  var SESSION = "site-" + Math.random().toString(36).slice(2);
  var messages = [];
  var hero = document.getElementById("hero");
  var msgsEl = document.getElementById("messages");
  var inputBar = document.getElementById("input-bar");
  var heroInput = document.getElementById("chat-input");
  var barInput = document.getElementById("chat-input-bar");
  var suggestions = document.getElementById("suggestions");
  var chatMode = false;

  function md(t) {
    return t
      .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
      .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/\\n\\n/g, "</p><p>")
      .replace(/\\n/g, "<br>")
      .replace(/^/, "<p>").replace(/$/, "</p>");
  }

  function enterChatMode() {
    if (chatMode) return;
    chatMode = true;
    hero.style.flex = "0";
    hero.style.paddingBottom = "0";
    suggestions.style.display = "none";
    document.getElementById("hero-prompt").style.display = "none";
    msgsEl.classList.add("active");
    inputBar.classList.add("active");
    barInput.focus();
  }

  function addMsg(role, text) {
    var div = document.createElement("div");
    div.className = "site-msg " + role;
    if (role === "bot") div.innerHTML = md(text);
    else div.textContent = text;
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return div;
  }

  function showTyping() {
    var div = document.createElement("div");
    div.className = "site-typing";
    div.innerHTML = "<span></span><span></span><span></span>";
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return div;
  }

  function send(text) {
    if (!text.trim()) return;
    enterChatMode();
    messages.push({ role: "user", content: text });
    addMsg("user", text);
    var typing = showTyping();

    fetch(API + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages, tenantId: TENANT, sessionId: SESSION }),
    })
    .then(function(r) { return r.json().catch(function() { return {}; }); })
    .then(function(data) {
      typing.remove();
      var reply = (data && typeof data.message === "string" && data.message.trim())
        ? data.message
        : "Sorry, I couldn't process that just now — please try again in a moment.";
      messages.push({ role: "assistant", content: reply });
      addMsg("bot", reply);
    })
    .catch(function() {
      typing.remove();
      addMsg("bot", "Something went wrong. Please try again.");
    });

    heroInput.value = "";
    barInput.value = "";
  }

  heroInput.addEventListener("keydown", function(e) { if (e.key === "Enter") send(this.value); });
  barInput.addEventListener("keydown", function(e) { if (e.key === "Enter") send(this.value); });
  document.getElementById("chat-send").addEventListener("click", function() { send(heroInput.value); });
  document.getElementById("chat-send-bar").addEventListener("click", function() { send(barInput.value); });

  document.querySelectorAll(".site-suggestion").forEach(function(el) {
    el.addEventListener("click", function() { send(this.textContent); });
  });
})();
</script>
</body>
</html>`);
});

// Create tenant
app.post("/api/tenants", (req, res) => {
  const isAdmin = adminOk(req);
  if (!isAdmin) {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!checkSignupRate(ip)) {
      res.status(429).json({ error: "Too many signups. Try again later." });
      return;
    }
  }

  const { email } = req.body;
  let siteUrl = String(req.body.siteUrl || "").trim();
  if (!email || !siteUrl) {
    res.status(400).json({ error: "email and siteUrl are required" });
    return;
  }

  // Accept bare domains ("example.com") — normalize to https://
  if (!/^https?:\/\//i.test(siteUrl)) siteUrl = "https://" + siteUrl;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(siteUrl);
    if (!/^https?:$/.test(parsedUrl.protocol) || !parsedUrl.hostname.includes(".")) throw new Error("bad");
  } catch {
    res.status(400).json({ error: "Invalid siteUrl" });
    return;
  }

  // Check if domain already exists
  const domain = parsedUrl.hostname;
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

    // Render owns scraping now (the VPS pipeline is gone) — queue the on-demand
    // scrape immediately, same bounded job as the claim flow. Without this the
    // tenant sat in "pending" forever and the landing signup hung on "Scraping...".
    worker.enqueue(tenant.id, siteUrl, 15);

    // Welcome / set-password email — ONLY for genuine self-serve signups (the public,
    // non-admin path). Outreach creates tenants via the admin path (?secret=); cold
    // prospects must NOT get a "set your password" email — that's a spam-complaint /
    // sender-reputation risk and isn't an approved outreach template.
    if (!isAdmin) {
      const protocol = req.protocol || "http";
      const host = req.get("host") || `localhost:${port}`;
      const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;
      sendWelcomeEmail(email, tenant.id, setupToken, baseUrl).catch((err) => {
        console.error("[create-tenant] Failed to send welcome email:", err.message);
      });
    } else {
      console.log(`[create-tenant] ${tenant.id}: admin/outreach create — welcome email skipped`);
    }

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

// Self-serve demo onboarding: a visitor claims a not-yet-live site. We create the tenant,
// queue an on-demand scrape, and the worker emails them when the bot is ready (sendBotReadyEmail).
app.post("/api/onboard-demo", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
  if (!adminOk(req) && !checkSignupRate(ip)) {
    res.status(429).json({ error: "Too many requests - please try again in a few minutes." });
    return;
  }
  const { email } = req.body || {};
  let siteUrl = String((req.body || {}).siteUrl || "").trim();
  if (!siteUrl || !email) { res.status(400).json({ error: "Website and email are required." }); return; }
  if (!/^https?:\/\//i.test(siteUrl)) siteUrl = "https://" + siteUrl;
  let origin: string, domain: string;
  try { const u = new URL(siteUrl); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw new Error("proto"); origin = u.origin; domain = u.hostname.replace(/^www\./, ""); }
  catch { res.status(400).json({ error: "Please enter a valid website URL (https://...)." }); return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) { res.status(400).json({ error: "Please enter a valid email address." }); return; }

  const MAX_PAGES = 15; // bounded on-demand scrape (keeps Render memory/time/cost in check)
  try {
    const existing = getTenantByDomain(domain);
    if (existing) {
      if (existing.status === "active") { res.json({ ready: true, tenantId: existing.id }); return; }
      if (["pending", "queued", "scraping"].includes(existing.status)) {
        if (email && existing.email !== email) updateTenant(existing.id, { email });
        // No VPS pipeline anymore: a claimed pending tenant must actually be
        // enqueued HERE or the claim hangs on "building" forever. "scraping" is
        // left alone — it's either genuinely in-flight or gets reset to pending
        // (and re-enqueued) by recoverStuckJobs on next boot.
        if (existing.status !== "scraping") worker.enqueue(existing.id, existing.siteUrl || origin, MAX_PAGES);
        res.json({ building: true, tenantId: existing.id }); return;
      }
      // broken / error -> re-onboard
      updateTenant(existing.id, { email, status: "pending" });
      worker.enqueue(existing.id, existing.siteUrl || origin, MAX_PAGES);
      console.log(`[onboard-demo] re-queued ${existing.id} (${domain}) -> notify ${email}`);
      res.json({ building: true, tenantId: existing.id }); return;
    }
    const tenant = createTenant(email, origin);
    worker.enqueue(tenant.id, origin, MAX_PAGES);
    console.log(`[onboard-demo] queued scrape for ${tenant.id} (${domain}) -> notify ${email}`);
    res.status(201).json({ building: true, tenantId: tenant.id });
  } catch (e: any) {
    console.error("[onboard-demo]", e?.message || e);
    res.status(500).json({ error: "Failed to start onboarding. Please try again." });
  }
});

// Diagnostic: tests THIS server's (Render's) email path — the same RESEND_API_KEY + FROM
// the bot-ready email uses — so we can tell whether a missing/wrong Render key is why the
// onboarding callback email never arrives (the worker swallows the Resend error).
app.post("/api/admin/email-diag", async (req, res) => {
  if (!ADMIN_SECRET || (req.query.secret as string) !== ADMIN_SECRET) { res.status(403).json({ error: "Forbidden" }); return; }
  const to = (req.query.to as string) || OWNER_EMAIL;
  const from = process.env.EMAIL_FROM || "Jakub <jakub@whisp.so>";
  const key = process.env.RESEND_API_KEY || "";
  const diag: any = { resendKeySet: !!key, keyLen: key.length, from, baseUrl: process.env.BASE_URL || "(unset)" };
  if (!key) { res.json({ ...diag, sent: false, reason: "RESEND_API_KEY is NOT set on Render" }); return; }
  try {
    // Replicate the bot-ready send shape (from + replyTo) to catch payload-level rejections too.
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, replyTo: "jakub@whisp.so", subject: "Whisp Render email diagnostic", html: "<p>If you received this, Render's email path works.</p>" }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.text();
    res.json({ ...diag, sent: r.ok, status: r.status, resendResponse: body.slice(0, 240) });
  } catch (e: any) { res.json({ ...diag, sent: false, error: e?.message || String(e) }); }
});

// Admin: re-scrape a specific list of tenant ids (e.g. the "active but no data" demos).
// Queues each on the worker so they get real vectors + the canonical facts.
app.post("/api/admin/rescrape-list", (req, res) => {
  if (!ADMIN_SECRET || (req.query.secret as string) !== ADMIN_SECRET) { res.status(403).json({ error: "Forbidden" }); return; }
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) { res.status(400).json({ error: "ids[] required" }); return; }
  const queued: string[] = [];
  for (const id of ids.slice(0, 300)) {
    const t = getTenant(id);
    if (!t) continue;
    updateTenant(id, { status: "pending" });
    worker.enqueue(id, t.siteUrl || `https://${t.domain}`, 15);
    tenantManager.evictTenant(id);
    queued.push(id);
  }
  console.log(`[rescrape-list] queued ${queued.length} tenant(s)`);
  res.json({ queued: queued.length, ids: queued });
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
// Most recent chat backend failure (BGE/Vectorize/LLM). Surfaced by /api/health-deep
// so an outage is detectable from monitoring instead of via a customer email.
let lastChatError: { tenantId: string; cause: string; msg: string; at: string } | null = null;

app.post("/api/chat", async (req, res) => {
  try {
    const { messages, sessionId, tenantId } = req.body;
    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: "messages required" });
      return;
    }
    // Hard cap per request (independent of the 5mb body limit): bounds the prompt size
    // sent to the paid LLM so a single call can't be inflated into a large completion cost.
    if (messages.length > 50) {
      res.status(400).json({ error: "Too many messages" });
      return;
    }
    const totalContentBytes = messages.reduce((n: number, m: any) => n + (typeof m?.content === "string" ? m.content.length : 0), 0);
    if (totalContentBytes > 32768) {
      res.status(400).json({ error: "Message too long" });
      return;
    }
    if (!tenantId) {
      res.status(400).json({ error: "tenantId required" });
      return;
    }

    let tenant = getTenant(tenantId);
    // Fallback: try normalized ID (underscore/hyphen mismatch between VPS and Render)
    if (!tenant) {
      const allTenants = listTenants();
      const normalized = tenantId.replace(/[-_]/g, "").toLowerCase();
      tenant = allTenants.find((t: any) => t.id.replace(/[-_]/g, "").toLowerCase() === normalized) || null;
    }
    if (!tenant) tenant = await reconcileTenantFromR2(tenantId);
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (tenant.status !== "active") {
      res.status(503).json({ error: "Tenant is not ready yet", status: tenant.status });
      return;
    }

    const sessionKey = sessionId || `${tenantId}_default`;
    const clientIp = ((req.headers["x-forwarded-for"] as string) || req.ip || "").split(",")[0].trim();
    const rc = checkChatRate(sessionKey);
    const iprc = clientIp ? checkIpChatRate(clientIp) : { ok: true as boolean, retry: undefined as number | undefined };
    if (!rc.ok || !iprc.ok) {
      res.status(429).json({
        error: "Rate limited",
        retryAfter: rc.retry || iprc.retry,
        message: "You're sending messages a bit fast — please wait a moment and try again.",
      });
      return;
    }

    const chat = await tenantManager.getChatForTenant(tenantId);
    console.log(`[chat:${tenantId}] "${(messages[messages.length - 1]?.content || "").slice(0, 60)}"`);

    const lastUserContent = messages[messages.length - 1]?.content || "";
    const chatIpRaw = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();
    // Internal/probe traffic must NEVER touch prospect analytics. Two signals:
    // (1) self-test IPs, (2) an explicit X-Whisp-Probe header / ?probe=1 marker that
    // the fleet health-check + dev test scripts set (robust regardless of origin IP —
    // the health-check pings every demo and otherwise inflates chat_start/sessions).
    const isProbe = !!req.headers["x-whisp-probe"] || (req.query as any)?.probe === "1";
    const isSelfChat = isProbe || chatIpRaw === "79.184.118.71" || chatIpRaw === "176.9.1.133" || chatIpRaw.startsWith("127.");
    // Shared fire-and-forget logging for both the streaming and non-streaming paths.
    const logResponse = (response: any) => {
      // Single D1 writer for chat messages (logMessage -> chat_messages). Skip
      // self-chat / internal probes so they don't pollute analytics.
      if (!isSelfChat) {
        logMessage(tenantId, sessionKey, "user", lastUserContent, { domain: tenant.domain }).catch(() => {});
        logMessage(tenantId, sessionKey, "assistant", response.message, {
          flowInvoked: response.flowSession?.flowId || null,
          navigatedTo: response.navigateTo || null,
          hadToolCall: !!(response.flowSession || response.navigateTo),
          domain: tenant.domain,
        }).catch(() => {});
      }
      if (messages.length <= 1 && !isSelfChat) {
        getEmailForTenant(tenantId).then(email => {
          if (email) recordEvent(email, "chat_start", { sessionId: sessionKey, firstMessage: lastUserContent.slice(0, 100) });
        }).catch(() => {});
        recordExperimentEvent("widget-start-state", `${chatIpRaw}_${tenantId}`, "", "chat_start", { tenantId }).catch(() => {});
      }
      // Capture gaps: either the model flagged the question as uncovered
      // ([[gap: ...]] marker / log_unknown action -> response.unknownQuestion)
      // or the grounding gate fired (grounded === false). Logged to D1
      // unknown_questions — the store the dashboard's gap view reads.
      const gapQuestion = response.unknownQuestion || (response.grounded === false ? lastUserContent.trim() : "");
      if (gapQuestion && !isSelfChat) {
        logUnknownQuestion(tenantId, gapQuestion).catch(() => {});
      }
    };

    // Streaming (SSE) path — surface the answer token-by-token for low perceived latency.
    if (req.body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering (Render)
      (res as any).flushHeaders?.();
      try {
        const full = await chat.chatStream(messages, sessionKey, (delta) => {
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        });
        res.write(`data: ${JSON.stringify({ done: true, message: full.message, sources: full.sources || [], grounded: full.grounded, navigateTo: (full as any).navigateTo || null, flowSession: (full as any).flowSession || null })}\n\n`);
        res.end();
        logResponse(full);
      } catch (error: any) {
        const m = String(error?.message || "");
        console.error(`[chat stream error] ${tenantId}: ${m.slice(0, 200)}`);
        lastChatError = { tenantId, cause: /OpenRouter request failed/i.test(m) ? (/\(402\)|insufficient credits/i.test(m) ? "llm-credits" : "llm-provider") : "stream-error", msg: m.slice(0, 300), at: new Date().toISOString() };
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: "backend_unavailable", message: "Sorry — I'm having trouble right now. Please try again in a moment." })}\n\n`);
          res.end();
        }
      }
      return;
    }

    {
      const response = await chat.chat(messages, sessionKey);
      logResponse(response);
      res.json(response);
    }
  } catch (error: any) {
    const msg = String(error?.message || "");
    // Classify the failure for logs + /api/health-deep. EVERY error caught here is
    // a transient backend/provider outage, NOT missing data — so the prospect-facing
    // message stays honest and recoverable regardless of cause.
    let cause = "unknown";
    if (/HTTP 401|HTTP 403|Vectorize (query|insert) failed/i.test(msg)) cause = "vectorize/cf-token";
    else if (/BGE embedding failed/i.test(msg)) cause = "bge-embeddings";
    else if (/OpenRouter request failed/i.test(msg)) cause = /\(402\)|insufficient credits/i.test(msg) ? "llm-credits" : "llm-provider";
    console.error(`[chat error] ${req.body?.tenantId} [${cause}]: ${msg.slice(0, 300)}`);
    lastChatError = { tenantId: req.body?.tenantId || "", cause, msg: msg.slice(0, 300), at: new Date().toISOString() };
    if (!res.headersSent) {
      // Previously the default branch told the prospect "I don't have this site's
      // details indexed yet" for ANY non-token error. But BGE outages, LLM provider
      // failures (incl. OpenRouter 402 "insufficient credits"), and unknown throws
      // are infra problems on FULLY-INDEXED demos — that message wrongly blamed
      // missing data and was the literal text behind the recurring "demo not working"
      // complaints. Be honest and recoverable; the readiness gate (not this catch)
      // is what keeps genuinely-empty tenants from ever going active.
      res.status(503).json({
        error: "backend_unavailable",
        message: "Sorry — I'm having trouble right now. Please try again in a moment.",
      });
    }
  }
});

// Global health check (for Render liveness). Stays SHALLOW on purpose: a backend
// outage (LLM credits, BGE) must NOT make Render kill a healthy container — the
// server is alive and should keep serving the honest "try again" message.
app.get("/api/health", (_, res) => {
  const tenants = listTenants();
  res.json({ status: "ok", tenants: tenants.length, active: tenants.filter(t => t.status === "active").length });
});

// --- Deep health + proactive monitoring --------------------------------------
// Shared by /api/health-deep AND the background monitor below. Probes every backend
// a live demo depends on (CF token/Vectorize, BGE, the LLM, R2) PLUS the LLM credit
// balance, so an outage OR an about-to-run-dry credential is caught from monitoring
// BEFORE a prospect emails "demo not working".
const LOW_BALANCE_USD = Number(process.env.LLM_LOW_BALANCE_USD || "5");

async function runDeepHealthChecks(): Promise<{ ok: boolean; lowBalance: boolean; checks: Record<string, any>; lastChatError: any; at: string }> {
  const checks: Record<string, any> = {};
  let lowBalance = false;

  // BGE embeddings
  try {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.BGE_API_KEY) h["X-API-Key"] = process.env.BGE_API_KEY;
    const r = await fetch(`${bgeBaseUrl()}/embed`, { method: "POST", headers: h, body: JSON.stringify({ texts: ["health"] }), signal: AbortSignal.timeout(8000) });
    checks.bge = { ok: r.ok, status: r.status };
  } catch (e: any) { checks.bge = { ok: false, error: String(e?.message || e).slice(0, 120) }; }

  // CF token / Vectorize (tiny query)
  try {
    await new CloudflareVectorizeStore({ tenantId: "__health__" }).search(new Array(1024).fill(0.01), 1);
    checks.vectorize = { ok: true };
  } catch (e: any) { checks.vectorize = { ok: false, error: String(e?.message || e).slice(0, 120) }; }

  // R2 reachability/auth — strict download distinguishes a real error from absence.
  try {
    const { downloadFromR2Strict } = await import("../src/storage/r2.js");
    await downloadFromR2Strict("config/cf-token");
    checks.r2 = { ok: true };
  } catch (e: any) { checks.r2 = { ok: false, error: String(e?.message || e).slice(0, 120) }; }

  // LLM provider — balance via the free /credits endpoint (proactive low-balance) and
  // the recent-chat-failure signal for a hard outage.
  try {
    const r = await fetch("https://openrouter.ai/api/v1/credits", { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY || ""}` }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = (await r.json()) as any;
      const tc = d?.data?.total_credits, tu = d?.data?.total_usage;
      const remaining = (typeof tc === "number" && typeof tu === "number") ? Math.round((tc - tu) * 100) / 100 : null;
      const creditOutage = lastChatError?.cause === "llm-credits" && (Date.now() - new Date(lastChatError.at).getTime() < 600000);
      const empty = remaining != null && remaining <= 0;
      const low = remaining != null && remaining > 0 && remaining < LOW_BALANCE_USD;
      if (low) lowBalance = true;
      checks.llm = { ok: !creditOutage && !empty, keyReachable: true, remaining, low, recentCreditFailure: creditOutage };
    } else {
      checks.llm = { ok: false, status: r.status };
    }
  } catch (e: any) { checks.llm = { ok: false, error: String(e?.message || e).slice(0, 120) }; }

  // Browserless (scrape dependency) — informational, only when configured. A dry
  // token silently produces 0-chunk scrapes + screenshot-less demos, so surface it.
  // v2 host + /json/version (the v1 chrome.browserless.io domain and its /pressure
  // endpoint are dead). Must match BROWSERLESS_HOST default in src/scraper/fetcher.ts.
  if (process.env.BROWSERLESS_TOKEN) {
    try {
      const blHost = process.env.BROWSERLESS_HOST || "production-sfo.browserless.io";
      const r = await fetch(`https://${blHost}/json/version?token=${process.env.BROWSERLESS_TOKEN}`, { signal: AbortSignal.timeout(8000) });
      checks.browserless = { ok: r.ok, status: r.status };
    } catch (e: any) { checks.browserless = { ok: false, error: String(e?.message || e).slice(0, 120) }; }
  }

  // Serving-critical health (Browserless excluded — live chat doesn't use it).
  const ok = !!(checks.bge?.ok && checks.vectorize?.ok && checks.llm?.ok && checks.r2?.ok);
  return { ok, lowBalance, checks, lastChatError, at: new Date().toISOString() };
}

let healthDeepCache: { at: number; body: any } | null = null;
app.get("/api/health-deep", async (req, res) => {
  let body;
  if (healthDeepCache && Date.now() - healthDeepCache.at < 60000) {
    body = healthDeepCache.body;
  } else {
    body = await runDeepHealthChecks();
    healthDeepCache = { at: Date.now(), body };
  }
  const status = body.ok ? 200 : 503;
  // Public callers get liveness only. The full payload (live LLM credit balance, backend
  // topology/IPs, internal error strings) is admin-only — otherwise it hands an attacker a
  // precise cost-drain target and infra map.
  if (!adminOk(req)) { res.status(status).json({ ok: body.ok }); return; }
  res.status(status).json(body);
});

// --- Background monitor + debounced ops alerts -------------------------------
// The whole point: learn about a dry credential / backend outage from monitoring,
// NOT from a prospect emailing "demo broken". Runs the deep checks on a timer and
// emails the owner when something is down or the LLM balance is low — debounced (the
// same problem is suppressed for 60 min) so it never spams, with one recovery note.
const OWNER_EMAIL = process.env.OWNER_EMAIL || "kubalol7982@gmail.com";
async function sendOpsAlert(subject: string, text: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn("[monitor] no RESEND_API_KEY — cannot send ops alert"); return; }
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.ALERT_FROM || "Whisp Monitor <monitor@whisp.so>", to: [OWNER_EMAIL], subject, text }),
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[monitor] ops alert emailed: ${subject}`);
  } catch (e: any) { console.error(`[monitor] alert email failed: ${e?.message || e}`); }
}

let lastAlertSig = "";
let lastAlertAt = 0;
let monitorWasHealthy = true;
let consecutiveBad = 0;
async function healthMonitorTick(): Promise<void> {
  try {
    const h = await runDeepHealthChecks();
    healthDeepCache = { at: Date.now(), body: h }; // warm the endpoint cache too
    // Exclude browserless from alert triggers — serving doesn't use it (VPS scrapes
    // with local Playwright), and it's already excluded from h.ok.
    const failing = Object.entries(h.checks).filter(([k, v]: any) => k !== "browserless" && v && v.ok === false).map(([k]) => k);
    const problem = !h.ok || h.lowBalance;
    // Require TWO consecutive bad ticks (~8 min) before alerting, so a single transient
    // probe timeout (a cold check, a momentary network blip) never fires a false
    // "DOWN" email. A real outage persists and alerts on the 2nd tick.
    consecutiveBad = problem ? consecutiveBad + 1 : 0;
    const sig = failing.sort().join(",") + (h.lowBalance ? "|lowbal" : "");
    const now = Date.now();
    if (problem && consecutiveBad >= 2) {
      if (sig !== lastAlertSig || now - lastAlertAt > 3600000) {
        lastAlertSig = sig; lastAlertAt = now; monitorWasHealthy = false;
        const subj = !h.ok
          ? `⚠️ Whisp backend DOWN: ${failing.join(", ") || "unknown"}`
          : `⚠️ Whisp LLM credits low: $${h.checks.llm?.remaining} remaining`;
        await sendOpsAlert(subj, `${subj}\n\nchecks:\n${JSON.stringify(h.checks, null, 2)}\n\nlastChatError: ${JSON.stringify(h.lastChatError)}\n\nhttps://whisp.so/api/health-deep`);
      }
    } else if (!monitorWasHealthy) {
      monitorWasHealthy = true; lastAlertSig = "";
      await sendOpsAlert("✅ Whisp backend recovered", "All health-deep checks are green again.");
    }
  } catch (e: any) { console.error(`[monitor] tick error: ${e?.message || e}`); }
}
setInterval(healthMonitorTick, 4 * 60 * 1000);

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

// Read-only: list active tenant ids with chunks. Used to enumerate targets for the
// canonical business-info backfill (the SQLite registry lives only here on the server).
app.get("/api/admin/active-tenant-ids", (req, res) => {
  if (!adminOk(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const ids = listTenants().filter((t) => t.status === "active" && t.chunksCount > 0).map((t) => t.id);
  res.json({ count: ids.length, ids });
});

// Admin rescrape single tenant (?maxPages=10 to limit crawl size)
app.post("/api/admin/rescrape/:tenantId", (req, res) => {
  if (!adminOk(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const tenant = getTenant(req.params.tenantId);
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
  const maxPages = parseInt(req.query.maxPages as string) || 20;
  const siteUrl = (req.query.siteUrl as string) || tenant.siteUrl || `https://${tenant.domain}`;
  if (!tenant.siteUrl && siteUrl) updateTenant(tenant.id, { siteUrl });
  // Render owns scraping now — this endpoint used to only flip status ("VPS
  // handles scraping") and silently never rescraped anything.
  worker.enqueuePriority(tenant.id, siteUrl, maxPages);
  tenantManager.evictTenant(tenant.id);
  res.json({ ok: true, queued: true, maxPages });
});

// Admin flush queue — stop scraping pending domains so only priority ones get scraped
app.post("/api/admin/flush-queue", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const tenants = listTenants();
  const pending = tenants.filter(t => t.status === "pending");
  for (const t of pending) {
    updateTenant(t.id, { status: "paused" });
  }
  worker.clearQueue();
  res.json({ ok: true, paused: pending.length });
});

// Admin bulk rescrape — re-enqueue all pending/error tenants
app.post("/api/admin/rescrape-all", (req, res) => {
  if (!adminOk(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const tenants = listTenants();
  const targets = tenants.filter(t => t.status === "pending" || t.status === "error" || (t.status === "active" && t.pagesCount === 0));
  const maxPages = Math.min(parseInt(req.query.maxPages as string) || 10, 50);
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
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
  }
  // Throttle online password brute force (keyed per-account, not per-proxy-IP).
  if (!checkAuthAttempt(`login:${String(email).toLowerCase()}`)) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
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

  const token = await createSession(tenant.id);
  res.json({ token, tenantId: tenant.id });
});

// Admin-gated login: mint a dashboard session for ANY tenant (support + e2e testing).
// Requires ADMIN_SECRET — not a public backdoor. ?redirect=1 stores the token and
// opens the dashboard directly; otherwise returns { token, tenantId } as JSON.
app.get("/api/admin/login-as", async (req, res) => {
  if (!ADMIN_SECRET || (req.query.secret as string) !== ADMIN_SECRET) { res.status(403).json({ error: "Forbidden" }); return; }
  const tenantId = ((req.query.tenantId as string) || "").trim();
  if (!tenantId) { res.status(400).json({ error: "tenantId required" }); return; }
  if (!getTenant(tenantId)) { res.status(404).json({ error: "Tenant not found" }); return; }
  const token = await createSession(tenantId);
  if (req.query.redirect === "1") {
    res.type("html").send('<!DOCTYPE html><meta charset="utf-8"><title>Signing in…</title><script>'
      + 'localStorage.setItem("wctx-dashboard-token",' + JSON.stringify(token) + ');'
      + 'localStorage.setItem("wctx-tenant-id",' + JSON.stringify(tenantId) + ');'
      + 'location.href="/dashboard";</script>Signing in…');
    return;
  }
  res.json({ token, tenantId });
});

// Setup password (first-time) — accepts either setup token or API key
app.post("/api/auth/setup-password", async (req, res) => {
  const { tenantId, apiKey, token: setupToken, password } = req.body;
  if (!tenantId || !password) {
    res.status(400).json({ error: "tenantId and password required" });
    return;
  }
  // Throttle brute force of the setup token / apiKey (account-takeover of unclaimed tenants).
  if (!checkAuthAttempt(`setup:${String(tenantId)}`)) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
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
    if (!tenant.setupToken || !safeStrEq(tenant.setupToken, setupToken)) {
      res.status(401).json({ error: "Invalid or expired setup token" });
      return;
    }
  } else if (apiKey) {
    if (!safeStrEq(tenant.apiKey, apiKey)) {
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

  const sessionToken = await createSession(tenantId);
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

// Conversations (from D1 chat_messages — persists across deploys)
app.get("/api/dashboard/conversations", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  res.json(await getConversations(tenantId, limit));
});

// Unknown questions (from D1 unknown_questions)
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

// Owners must be able to remove a wrong/outdated note — a bad answer the bot
// keeps repeating is worse than the original gap. Index-addressed (notes have
// no ids); the dashboard passes the array index it rendered.
app.delete("/api/dashboard/context-notes/:index", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const idx = parseInt(req.params.index, 10);
  const notesPath = resolve(__dirname, `../data/${tenantId}/context_notes.json`);
  if (!existsSync(notesPath) || !Number.isInteger(idx) || idx < 0) { res.status(404).json({ error: "Not found" }); return; }
  const notes: any[] = JSON.parse(await readFile(notesPath, "utf-8"));
  if (idx >= notes.length) { res.status(404).json({ error: "Not found" }); return; }
  const [removed] = notes.splice(idx, 1);
  await writeFile(notesPath, JSON.stringify(notes, null, 2));
  try {
    const chat = await tenantManager.getChatForTenant(tenantId);
    chat.setContextNotes(notes);
  } catch { /* tenant may not be cached yet */ }
  res.json({ ok: true, removed });
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

// --- Flow recording (owner-only) -------------------------------------------
// The dashboard's "Record flow" button opens /record, which mints a short-lived
// record token bound to the owner's tenant. The bookmarklet injects recorder.js
// on the owner's own site; the recorder POSTs the captured steps here with that
// token. The LLM then names/parameterizes the flow — no metadata prompts.
// Stateless HMAC tokens — an in-memory map died on every deploy (zero-downtime
// deploys are frequent here), silently 401-ing recordings mid-session. Signed
// with ADMIN_SECRET (mandatory, strong); survives restarts and horizontal scale.
function mintRecordToken(tenantId: string): string {
  const payload = `${tenantId}.${Date.now() + 60 * 60 * 1000}`;
  const sig = createHmac("sha256", ADMIN_SECRET).update(payload).digest("hex").slice(0, 32);
  return Buffer.from(payload).toString("base64url") + "." + sig;
}
function validateRecordToken(rt: string): string | null {
  try {
    const dot = rt.lastIndexOf(".");
    if (dot <= 0) return null;
    const b64 = rt.slice(0, dot), sig = rt.slice(dot + 1);
    const payload = Buffer.from(b64, "base64url").toString();
    const expect = createHmac("sha256", ADMIN_SECRET).update(payload).digest("hex").slice(0, 32);
    if (!safeStrEq(sig, expect)) return null;
    const i = payload.lastIndexOf(".");
    const tenantId = payload.slice(0, i);
    const exp = Number(payload.slice(i + 1));
    if (!tenantId || !Number.isFinite(exp) || exp < Date.now()) return null;
    return tenantId;
  } catch { return null; }
}

app.get("/api/dashboard/record-token", authMiddleware, (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenant = getTenant(tenantId);
  res.json({ tenantId, recordToken: mintRecordToken(tenantId), expiresInMinutes: 60, siteUrl: (tenant && tenant.siteUrl) || "" });
});

// Owner-panel flow list (the widget's "View flows"). Gated by the same record
// token — flow trigger phrases are owner intel, not visitor content.
app.get("/api/flows", async (req, res) => {
  const rt = String(req.query.rt || "");
  const tokenTenant = validateRecordToken(rt);
  if (!tokenTenant) { res.status(401).json({ error: "Recording session expired" }); return; }
  const flows = await getFlows(tokenTenant);
  res.json(flows.map((f) => ({ id: f.id, name: f.name, status: f.status, steps: f.steps, triggerPhrases: f.triggerPhrases })));
});

app.post("/api/flows/record", async (req, res) => {
  const rt = String(req.query.rt || req.headers["x-record-token"] || "");
  const tokenTenant = validateRecordToken(rt);
  if (!tokenTenant) {
    console.warn(`[flows] record POST rejected: invalid/expired token`);
    res.status(401).json({ error: "Recording session expired — open whisp.so/record again" });
    return;
  }
  const tenantId = tokenTenant;
  const raw = req.body || {};
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (rawSteps.length === 0) { res.status(400).json({ error: "No steps recorded" }); return; }
  if (rawSteps.length > 200) { res.status(400).json({ error: "Too many steps" }); return; }

  const flowId = String(raw.id || `flow_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || `flow_${Date.now()}`;
  const now = new Date().toISOString();
  // Raw fallback: recorded steps saved as a draft — visible in the dashboard even
  // if the LLM analysis fails, so a recording is never silently lost.
  const fallbackFlow = {
    id: flowId,
    name: String(raw.name || "Recorded flow (needs review)").slice(0, 120),
    description: "Automatically recorded flow — review and activate in the dashboard.",
    triggerPhrases: [],
    steps: rawSteps.map((s: any, i: number) => ({
      id: String(s.id || `step_${i}`), order: s.order ?? i, action: s.action,
      target: s.target || {}, value: s.value, description: s.description || "", timeout: s.timeout || 10000,
    })),
    requiredInputs: Array.isArray(raw.requiredInputs) ? raw.requiredInputs : [],
    createdAt: String(raw.createdAt || now), updatedAt: now, status: "draft" as const,
  };

  try {
    const or = new OpenRouterProvider({ maxTokens: 4096, temperature: 0.2 });
    const analyzed = await analyzeRecordedFlow(
      { id: flowId, steps: rawSteps, startUrl: String(raw.startUrl || req.headers.referer || ""), recordedAt: fallbackFlow.createdAt },
      { generate: async (system, prompt) => (await or.chat([{ role: "system", content: system }, { role: "user", content: prompt }])).content }
    );
    await saveFlow(tenantId, analyzed.flow);
    try {
      const chat = await tenantManager.getChatForTenant(tenantId);
      chat.loadFlows((await getFlows(tenantId)).filter((f) => f.status === "active"));
    } catch { /* chat instance not cached yet — flows load on demand */ }
    console.log(`[flows] ${tenantId}: recorded + analyzed "${analyzed.flow.name}" (${analyzed.flow.steps.length} steps)`);
    res.json({ ok: true, flowId: analyzed.flow.id, name: analyzed.flow.name, status: analyzed.flow.status });
  } catch (err: any) {
    console.error(`[flows] ${tenantId}: LLM analysis failed (${err?.message}) — saving raw draft`);
    await saveFlow(tenantId, fallbackFlow as any);
    res.json({ ok: true, flowId: fallbackFlow.id, name: fallbackFlow.name, status: "draft", analysisFailed: true });
  }
});

app.get("/record", (req, res) => {
  const base = process.env.BASE_URL || "https://" + (req.get("host") || "whisp.so");
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Record a flow - Whisp</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0a0e1a;color:#e7e9ee;font-family:'Archivo',-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:560px;background:rgba(22,24,34,0.92);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px 36px;box-shadow:0 8px 32px rgba(0,0,0,0.35)}
.badge{display:inline-block;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#60a5fa;margin-bottom:18px}
h1{font-family:'DM Serif Display',Georgia,serif;font-weight:400;font-size:27px;line-height:1.25;margin:0 0 12px}
p.sub{font-size:14.5px;color:#9aa3b2;line-height:1.6;margin:0 0 24px}
ol{margin:0 0 24px;padding-left:20px;font-size:14px;color:#9aa3b2;line-height:1.8}
ol strong{color:#e7e9ee}
.bm{display:inline-block;padding:13px 22px;border-radius:10px;background:#3b82f6;color:#fff;font-weight:600;font-size:14px;text-decoration:none;cursor:grab}
.bm:hover{background:#2563eb}
.hint{font-size:12px;color:#5b6472;margin-top:10px;line-height:1.5}
textarea{width:100%;height:88px;margin-top:18px;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);color:#9aa3b2;font-family:ui-monospace,monospace;font-size:11px;resize:none}
#login,#err{display:none;text-align:center}
#login a{color:#60a5fa}
.fine{font-size:12px;color:#5b6472;margin-top:18px;border-top:1px solid rgba(255,255,255,0.08);padding-top:14px;line-height:1.6}
</style></head>
<body><div class="card">
  <div class="badge">Whisp — Flow recorder</div>
  <div id="main" style="display:none">
    <h1>Record a flow on your website</h1>
    <p class="sub">Show the assistant how something is done on your site — a booking, a contact form, an order. Do it once; the AI learns the steps, names the flow and can guide every visitor through it.</p>
    <label style="display:block;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#7b8494;margin:0 0 7px">Page with your Whisp widget installed</label>
    <input id="site-url" type="text" inputmode="url" autocapitalize="none" spellcheck="false" style="width:100%;padding:13px 15px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);color:#f1f5f9;font-family:inherit;font-size:15px;margin-bottom:14px" />
    <a class="bm" id="bm" href="#" target="_blank" rel="noopener">⏺ Open the page in recording mode</a>
    <ol style="margin-top:22px">
      <li><strong>The page opens</strong> with the widget in owner mode.</li>
      <li>Click <strong>Owner → Record a flow</strong> in the widget.</li>
      <li><strong>Perform the action</strong> (fill the form, click through), then press Stop.</li>
      <li>Done — the AI names the flow and extracts its inputs automatically.</li>
    </ol>
    <p class="fine">The recording session is valid for 60 minutes and only works for your account. Recorded flows appear in your <a href="/dashboard" style="color:#60a5fa">dashboard</a>.</p>
  </div>
  <div id="login">
    <h1>Log in first</h1>
    <p class="sub">Recording is owner-only. <a href="/auth/login">Log in to your dashboard</a>, then come back here.</p>
  </div>
  <div id="err">
    <h1>Session expired</h1>
    <p class="sub"><a href="/auth/login">Log in again</a> and reopen this page.</p>
  </div>
</div>
<script>
(function(){
  var token = localStorage.getItem('wctx-dashboard-token');
  if (!token) { document.getElementById('login').style.display = 'block'; return; }
  fetch('${base}/api/dashboard/record-token', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r){ if (!r.ok) throw new Error('auth'); return r.json(); })
    .then(function(d){
      var input = document.getElementById('site-url');
      input.value = d.siteUrl || '';
      function buildHref(){
        var u = (input.value || '').trim();
        if (!u) return '#';
        if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
        return u + (u.indexOf('?') === -1 ? '?' : '&') + 'wctx-owner=true&wctx_rt=' + encodeURIComponent(d.recordToken);
      }
      var bm = document.getElementById('bm');
      bm.setAttribute('href', buildHref());
      input.addEventListener('input', function(){ bm.setAttribute('href', buildHref()); });
      document.getElementById('main').style.display = 'block';
    })
    .catch(function(){ document.getElementById('err').style.display = 'block'; });
})();
</script></body></html>`);
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
// ─── Knowledge base: visualize + edit chunks ─────────────────────────────
// Chunk CONTENT lives in Vectorize metadata, not context-meta (which only has
// the page list). So the KB tree reads the tenant's vectors directly. With a
// search term we embed it for real semantic matches; without, a fixed probe
// surfaces an arbitrary slice (capped at topK 100).
function bgeProvider() {
  return new BGEEmbeddingProvider({
    host: process.env.BGE_HOST,
    port: process.env.BGE_PORT ? parseInt(process.env.BGE_PORT) : undefined,
  });
}
async function adjustChunkCount(tenantId: string, delta: number) {
  try {
    const metaPath = resolve(__dirname, `../data/${tenantId}/context-meta.json`);
    if (!existsSync(metaPath)) return;
    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    meta.chunksCount = Math.max(0, (meta.chunksCount || 0) + delta);
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
  } catch { /* best effort — viz still works off Vectorize */ }
}

app.get("/api/dashboard/chunks", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const search = ((req.query.search as string) || "").trim();
  const store = new CloudflareVectorizeStore({ tenantId });

  // Vectorize caps topK at 20 when returnMetadata="all" (error 40025) — the old
  // single search(vec, 100) here ALWAYS 400'd, so the KB browser showed "No
  // knowledge yet" next to a real count. Search path: relevance-ranked top 20
  // (cap-legal). Browse path: two-step — id probe without metadata (topK 100
  // allowed), then hydrate metadata via get_by_ids.
  let results: any[] = [];
  try {
    if (search) {
      const queryVec = (await bgeProvider().embed([search]))[0];
      results = await store.search(queryVec, 20);
    } else {
      const idHits = await store.searchIds(new Array(1024).fill(0.01), 100);
      results = await store.getByIds(idHits);
    }
  } catch (e: any) {
    console.error(`[dashboard:chunks] ${tenantId}: ${e.message}`);
    results = [];
  }

  // Group chunks by source page (url) into the folder tree the dashboard expects.
  const byUrl = new Map<string, any>();
  for (const r of results) {
    const url = (r.metadata && r.metadata.url) || "manual://added";
    if (!byUrl.has(url)) {
      const isManual = String(url).indexOf("manual") === 0;
      byUrl.set(url, { url, title: isManual ? "Added materials" : ((r.metadata && r.metadata.title) || url), chunks: [] });
    }
    const hh = (r.metadata && r.metadata.headingHierarchy) || [];
    byUrl.get(url).chunks.push({
      id: r.id,
      heading: Array.isArray(hh) && hh.length ? hh[hh.length - 1] : ((r.metadata && r.metadata.title) || ""),
      type: (r.metadata && r.metadata.type) || "content",
      content: r.content || "",
    });
  }

  // Authoritative total comes from context-meta (the Vectorize query caps at 100).
  let total = results.length;
  try {
    const metaPath = resolve(__dirname, `../data/${tenantId}/context-meta.json`);
    if (existsSync(metaPath)) total = JSON.parse(await readFile(metaPath, "utf-8")).chunksCount || results.length;
  } catch { /* ignore */ }

  res.json({ total, pages: Array.from(byUrl.values()), truncated: results.length >= 100 });
});

// Upload a free-text knowledge chunk. Embeds it and upserts into Vectorize so the
// bot retrieves it like any scraped chunk. Deliberately NOT tracked in
// vector-ids.json, so a re-scrape's orphan cleanup leaves it alone (owner-added
// material survives re-scrapes).
app.post("/api/chunks", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const content = ((req.body && req.body.content) || "").toString().trim();
  const title = (((req.body && req.body.title) || "").toString().trim()) || "Added material";
  if (!content) { res.status(400).json({ error: "content required" }); return; }
  if (content.length > 20000) { res.status(400).json({ error: "content too long (max 20000 chars)" }); return; }
  try {
    const vec = (await bgeProvider().embed([title + "\n\n" + content]))[0];
    const id = "manual-" + createHash("sha256").update(content).digest("hex").slice(0, 16);
    await new CloudflareVectorizeStore({ tenantId }).upsert([{
      id, vector: vec, content,
      metadata: { title, url: "manual://added", type: "manual", headingHierarchy: [title] },
    }]);
    await adjustChunkCount(tenantId, +1);
    try { tenantManager.evictTenant(tenantId); } catch { /* not cached */ }
    res.status(201).json({ id, ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Edit a chunk's content (re-embed + overwrite the same id).
app.put("/api/chunks/:id", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const id = req.params.id;
  const content = ((req.body && req.body.content) || "").toString().trim();
  if (!content) { res.status(400).json({ error: "content required" }); return; }
  if (content.length > 20000) { res.status(400).json({ error: "content too long" }); return; }
  try {
    const vec = (await bgeProvider().embed([content]))[0];
    await new CloudflareVectorizeStore({ tenantId }).upsert([{
      id, vector: vec, content,
      metadata: { title: "", url: "manual://added", type: "edited", headingHierarchy: [] },
    }]);
    try { tenantManager.evictTenant(tenantId); } catch { /* not cached */ }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Delete a chunk.
app.delete("/api/chunks/:id", authMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const id = req.params.id;
  try {
    await new CloudflareVectorizeStore({ tenantId }).delete([id]);
    await adjustChunkCount(tenantId, -1);
    try { tenantManager.evictTenant(tenantId); } catch { /* not cached */ }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
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

  // Render terminates TLS at the proxy, so req.protocol reads "http" — which made
  // the embed snippet load http://whisp.so/widget.js and get mixed-content-blocked
  // on every https customer site. Prefer BASE_URL; never emit http for non-local.
  const host = req.get("host") || `localhost:${port}`;
  const baseUrl = process.env.BASE_URL
    || (host.startsWith("localhost") ? `http://${host}` : `https://${host}`);

  const embedCode = `<script>
(function() {
  var s = document.createElement('script');
  s.src = '${baseUrl}/widget.js';
  s.setAttribute('data-tenant-id', '${tenantId}');
  s.setAttribute('data-api-url', '${baseUrl}');
  document.head.appendChild(s);
})();
</script>`;

  // siteUrl/domain/brandName drive the dashboard's "Open site" link + header title
  // (it previously linked apiUrl — i.e. whisp.so — instead of the tenant's site).
  res.json({
    embedCode,
    tenantId,
    apiUrl: baseUrl,
    siteUrl: tenant.siteUrl || (tenant.domain ? `https://${tenant.domain}` : null),
    domain: tenant.domain || null,
    brandName: (tenant as any).brandName || null,
  });
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

// Admin conversations — view chats across all or specific tenants
app.get("/api/admin/conversations", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const tenantId = req.query.tenant as string | undefined;
  const limit = Math.min(parseInt(req.query.n as string) || 20, 100);

  if (tenantId) {
    const convos = await getConversations(tenantId, limit);
    res.json({ tenant: tenantId, conversations: convos });
    return;
  }

  // Recent conversations across all tenants
  const tenants = listTenants().filter((t: any) => t.status === "active" && t.chunksCount > 0);
  const all: any[] = [];
  for (const t of tenants) {
    try {
      const convos = await getConversations(t.id, 5);
      for (const c of convos) all.push({ ...c, tenantId: t.id, domain: t.domain });
    } catch {}
  }
  all.sort((a, b) => new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime());
  res.json({ total: all.length, conversations: all.slice(0, limit) });
});

// Admin full conversation messages
app.get("/api/admin/messages", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const tenantId = req.query.tenant as string;
  const sessionId = req.query.session as string | undefined;
  const limit = Math.min(parseInt(req.query.n as string) || 200, 1000);
  if (!tenantId) return res.status(400).json({ error: "tenant required" });

  const messages = await getMessages(tenantId, { limit });
  if (sessionId) {
    res.json(messages.filter((m: any) => m.sessionId === sessionId));
  } else {
    res.json(messages);
  }
});

// Admin update tenant (used by VPS outreach to mark tenants as active after remote scraping)
app.post("/api/admin/update-tenant/:tenantId", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  let tenant = getTenant(req.params.tenantId);
  const { status, chunksCount, pagesCount, domain, siteUrl } = req.body;
  if (!tenant && domain) {
    // Register under the REQUESTED id (which is the VPS scraper's id == the
    // Vectorize namespace). Do NOT retarget by domain to a different-id row — that
    // would mark a row 'active' whose vector namespace is empty (audit hole).
    tenant = ensureTenant(req.params.tenantId, `info@${domain}`, domain, siteUrl || `https://${domain}`);
  }
  if (!tenant) return res.status(404).json({ error: "Not found and no domain to create" });
  const updates: any = {};
  if (status) updates.status = status;
  if (chunksCount !== undefined) updates.chunksCount = chunksCount;
  if (pagesCount !== undefined) updates.pagesCount = pagesCount;
  updateTenant(tenant.id, updates);
  res.json({ ok: true, tenantId: tenant.id });
});

// Admin upload screenshot (from VPS scraper)
app.post("/api/admin/screenshot/:tenantId", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const safe = safeTenantDir(req.params.tenantId);
  if (!safe) { res.status(400).json({ error: "bad tenant id" }); return; }
  const tenantDir = safe.dir;
  if (!existsSync(tenantDir)) mkdirSync(tenantDir, { recursive: true });
  const screenshotPath = resolve(tenantDir, "screenshot.png");
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const buffer = Buffer.concat(chunks);
    writeFile(screenshotPath, buffer).then(() => {}).catch(() => {});
    res.json({ ok: true, size: buffer.length });
  });
});

// Admin upload file for tenant (from VPS scraper)
app.post("/api/admin/upload-file/:tenantId/:filename", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const allowed = ["context-meta.json", "business-info.json", "auto-context-notes.json"];
  if (!allowed.includes(req.params.filename)) return res.status(400).json({ error: "Not allowed" });
  const safe = safeTenantDir(req.params.tenantId);
  if (!safe) { res.status(400).json({ error: "bad tenant id" }); return; }
  const tenantDir = safe.dir;
  if (!existsSync(tenantDir)) mkdirSync(tenantDir, { recursive: true });
  const filePath = resolve(tenantDir, req.params.filename);
  if (!filePath.startsWith(tenantDir + sep)) { res.status(400).json({ error: "bad path" }); return; }
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", async () => {
    await writeFile(filePath, Buffer.concat(chunks));
    tenantManager.evictTenant(safe.id);
    res.json({ ok: true });
  });
});

// Resend webhook (delivery, open, click, bounce events)
app.post("/api/webhooks/resend", async (req, res) => {
  const { type, data } = req.body || {};
  const email = data?.to?.[0] || data?.email;
  if (email && type) {
    recordEmailEvent(email, type, data?.email_id).catch(() => {});
  }
  res.status(200).send("OK");
});

// ============================================================================
// Voice outreach (Twilio) — call businesses, play a recorded pitch, capture
// call-backs and SMS replies. Companion runner: scripts/voice-outreach.ts
// ============================================================================
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
const VOICE_FORWARD_TO = process.env.VOICE_FORWARD_TO || ""; // user's cell for call-back forwarding

// Do-not-call list — numbers that texted STOP or were added manually. Mirrors the
// UNSUBSCRIBED email pattern below. The voice-outreach runner pulls this via
// GET /api/voice/suppression before each batch so STOP opt-outs stop future calls.
const VOICE_SUPPRESSION = new Set<string>();
const voiceSuppressionPath = resolve(__dirname, "../data/voice-suppression.json");
try { (JSON.parse(require("fs").readFileSync(voiceSuppressionPath, "utf-8")) as string[]).forEach(n => VOICE_SUPPRESSION.add(n)); } catch {}
function saveVoiceSuppression() { writeFile(voiceSuppressionPath, JSON.stringify([...VOICE_SUPPRESSION], null, 2)).catch(() => {}); }

const voiceRepliesPath = resolve(__dirname, "../data/voice-replies.json");

function xmlEscape(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Validate Twilio's X-Twilio-Signature so these public endpoints can't be abused.
// Algorithm: HMAC-SHA1(authToken, fullUrl + sorted(POST params concatenated)) -> base64.
function validateTwilio(req: express.Request): boolean {
  if (!TWILIO_AUTH_TOKEN) return false; // fail closed until configured
  const sig = req.get("X-Twilio-Signature");
  if (!sig) return false;
  const base = (process.env.PUBLIC_BASE_URL || ("https://" + req.get("host") || "")).replace(/\/$/, "");
  const url = base + req.originalUrl;
  const params = (req.body && typeof req.body === "object") ? req.body : {};
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join("");
  const expected = createHmac("sha1", TWILIO_AUTH_TOKEN).update(Buffer.from(data, "utf-8")).digest("base64");
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// TwiML the call executes: play the recorded pitch, then hang up. The recording
// itself asks the prospect to call back or text. ?audio=<file> selects which mp3
// under public/voice/ to play (defaults to whisp-pitch-pl.mp3).
app.all("/api/voice/twiml", (req, res) => {
  if (!validateTwilio(req)) { res.status(403).send("Forbidden"); return; }
  const raw = (req.query.audio as string) || "whisp-pitch-pl.mp3";
  const audio = raw.replace(/[^a-zA-Z0-9._-]/g, ""); // prevent path traversal
  const base = (process.env.PUBLIC_BASE_URL || ("https://" + req.get("host"))).replace(/\/$/, "");
  const audioUrl = `${base}/voice/${audio}`;
  res.setHeader("Content-Type", "text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Play>${xmlEscape(audioUrl)}</Play>\n  <Hangup/>\n</Response>`);
});

// Live voice bot (Twilio ConversationRelay): Twilio does Polish STT+TTS+turn-taking and
// connects to our WebSocket (/api/voice/relay), which streams answers from the tenant chat.
// Query overrides (?tenantId / ?tts / ?voice) let you A/B a voice without a redeploy.
app.all("/api/voice/relay-twiml", (req, res) => {
  if (!validateTwilio(req)) { res.status(403).send("Forbidden"); return; }
  const wsUrl = `wss://${req.get("host")}/api/voice/relay`;
  const tenantId = (((req.query.tenantId as string) || process.env.VOICE_BOT_TENANT || "")).replace(/[^a-zA-Z0-9_-]/g, "");
  const ttsProvider = (((req.query.tts as string) || process.env.VOICE_TTS_PROVIDER || "Google")).replace(/[^a-zA-Z]/g, "");
  const voice = (((req.query.voice as string) || process.env.VOICE_TTS_VOICE || "")).replace(/[^a-zA-Z0-9._-]/g, "");
  const greeting = process.env.VOICE_GREETING || "Dzień dobry, z tej strony asystent Whisp. W czym mogę pomóc?";
  const voiceAttr = voice ? ` voice="${xmlEscape(voice)}"` : "";
  const prospect = String(req.body?.To || req.body?.Called || "").replace(/[^0-9+]/g, ""); // the number we dialed → SMS target
  res.setHeader("Content-Type", "text/xml");
  // STT tuning: speechTimeout=800 (fixed short end-of-speech gap so a lone "tak"/"nie"
  // finalizes instead of being swallowed by adaptive endpointing — the #1 dropped-word fix);
  // reportInputDuringAgentSpeech=speech (deliver a reply spoken over the greeting);
  // nova-3 + hints bias the short answer words; dtmfDetection adds a 1/2 fallback.
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n    <ConversationRelay url="${xmlEscape(wsUrl)}" welcomeGreeting="${xmlEscape(greeting)}" language="pl-PL" transcriptionProvider="Deepgram" speechModel="nova-3-general" speechTimeout="800" reportInputDuringAgentSpeech="speech" interruptible="any" interruptSensitivity="medium" dtmfDetection="true" hints="Whisp,Wisp,tak,nie,ok,zgoda,potwierdzam,anuluj,jeden,dwa" ttsProvider="${xmlEscape(ttsProvider)}"${voiceAttr} elevenlabsTextNormalization="on">\n      <Parameter name="tenantId" value="${xmlEscape(tenantId)}"/>\n      <Parameter name="prospect" value="${xmlEscape(prospect)}"/>\n    </ConversationRelay>\n  </Connect>\n</Response>`);
});

// Call status callbacks (StatusCallbackEvent=completed). Logged to the admin log
// ring; the runner separately polls Twilio for the authoritative per-call outcome.
app.post("/api/voice/status", (req, res) => {
  if (!validateTwilio(req)) { res.status(403).send("Forbidden"); return; }
  const { To, CallStatus, AnsweredBy, CallDuration, CallSid } = req.body || {};
  console.log(`[voice-status] ${To} status=${CallStatus} answeredBy=${AnsweredBy || "-"} dur=${CallDuration || 0}s sid=${(CallSid || "").slice(0, 10)}`);
  res.status(204).send("");
});

// Inbound SMS — a prospect replying to the campaign number. Log it, email the
// owner, and honor STOP/NIE opt-outs by adding the sender to the suppression list.
app.post("/api/voice/sms-in", (req, res) => {
  if (!validateTwilio(req)) { res.status(403).send("Forbidden"); return; }
  const from = (req.body?.From || "").trim();
  const body = (req.body?.Body || "").trim();
  const optOut = /^\s*(stop|nie|unsubscribe|wypisz|stop nie)\b/i.test(body);
  console.log(`[voice-sms] from=${from} optOut=${optOut} body="${body.slice(0, 80)}"`);

  if (from) {
    appendFile(voiceRepliesPath, JSON.stringify({ ts: new Date().toISOString(), from, body }) + "\n").catch(() => {});
    if (optOut) { VOICE_SUPPRESSION.add(from); saveVoiceSuppression(); }
    // Notify the owner so replies are actually seen (no inbox on the campaign number).
    const key = process.env.RESEND_API_KEY;
    if (key) {
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.ALERT_FROM || "Whisp Voice <monitor@whisp.so>",
          to: [OWNER_EMAIL],
          subject: optOut ? `Voice campaign: OPT-OUT from ${from}` : `Voice campaign reply from ${from}`,
          text: `From: ${from}\n${optOut ? "(STOP — added to do-not-call list)\n" : ""}\n${body}`,
        }),
      }).catch(() => {});
    }
  }
  // Empty TwiML: acknowledge without auto-replying (avoids unsolicited outbound SMS).
  res.setHeader("Content-Type", "text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`);
});

// Inbound voice — a prospect calling the campaign number back. Forward to the
// owner's cell if configured; otherwise leave a short Polish voicemail prompt.
app.post("/api/voice/incoming", (req, res) => {
  if (!validateTwilio(req)) { res.status(403).send("Forbidden"); return; }
  const from = (req.body?.From || "").trim();
  console.log(`[voice-incoming] call-back from ${from}`);
  res.setHeader("Content-Type", "text/xml");
  if (VOICE_FORWARD_TO && TWILIO_FROM_NUMBER) {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Dial callerId="${xmlEscape(TWILIO_FROM_NUMBER)}" timeout="25">${xmlEscape(VOICE_FORWARD_TO)}</Dial>\n</Response>`);
  } else {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say language="pl-PL">Dziękujemy za telefon. Proszę zostawić wiadomość po sygnale, oddzwonimy.</Say>\n  <Record maxLength="120" playBeep="true"/>\n</Response>`);
  }
});

// Suppression list for the runner (mirrors GET /api/admin/unsubscribed usage).
app.get("/api/voice/suppression", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  res.json([...VOICE_SUPPRESSION]);
});

// Manually add numbers to the do-not-call list. Body: { numbers: ["+48..."] }
app.post("/api/voice/suppress", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const nums: string[] = Array.isArray(req.body?.numbers) ? req.body.numbers : [];
  nums.forEach(n => { const t = String(n).trim(); if (t) VOICE_SUPPRESSION.add(t); });
  saveVoiceSuppression();
  res.json({ ok: true, total: VOICE_SUPPRESSION.size });
});

// Analytics endpoints
app.get("/api/admin/analytics/overview", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const [templates, funnel] = await Promise.all([getTemplateStats(), getFunnel()]);
  res.json({ templates, funnel });
});

app.get("/api/admin/analytics/breakdown", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const [byCountry, byIndustry] = await Promise.all([getCountryBreakdown(), getIndustryBreakdown()]);
  res.json({ byCountry, byIndustry });
});

app.get("/api/admin/analytics/daily", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const days = parseInt(req.query.days as string) || 7;
  res.json(await getDailyStats(days));
});

// Conversation analytics
app.get("/api/admin/analytics/conversations", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const limit = Math.min(parseInt(req.query.n as string) || 50, 200);
  const summary = await getConversationSummary(limit);
  res.json(summary);
});

app.get("/api/admin/analytics/conversation/:tenantId/:sessionId", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const messages = await getConversation(req.params.tenantId, req.params.sessionId);
  res.json(messages);
});

// Experiment results
app.get("/api/admin/analytics/experiments", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const expId = (req.query.id as string) || "widget-start-state";
  const results = await getExperimentResults(expId);
  res.json({ experiment: expId, results });
});

// Admin tenants list
app.get("/api/admin/tenants", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const tenants = listTenants().map((t: any) => ({
    id: t.id, domain: t.domain, email: t.email, status: t.status, chunksCount: t.chunksCount,
  }));
  res.json(tenants);
});

// Admin demo visits
app.get("/api/admin/demo-visits", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const n = Math.min(parseInt(req.query.n as string) || 50, DEMO_VISITS_MAX);
  const tenant = req.query.tenant as string | undefined;
  let visits = DEMO_VISITS;
  if (tenant) visits = visits.filter(v => v.tenantId === tenant);
  const unique = new Set(visits.map(v => v.tenantId));
  res.json({ total: visits.length, uniqueTenants: unique.size, visits: visits.slice(-n) });
});

// Admin logs endpoint
app.get("/api/admin/logs", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  const level = req.query.level as string | undefined;
  const n = Math.min(parseInt(req.query.n as string) || 100, LOG_MAX);
  const search = (req.query.q as string || "").toLowerCase();
  let logs = LOG_RING;
  if (level) logs = logs.filter(l => l.level === level);
  if (search) logs = logs.filter(l => l.msg.toLowerCase().includes(search));
  res.json(logs.slice(-n));
});

// Email unsubscribe (one-click POST + GET confirmation page)
const UNSUBSCRIBED = new Set<string>();
const unsubPath = resolve(__dirname, "../data/unsubscribed.json");
try { const saved = JSON.parse(require("fs").readFileSync(unsubPath, "utf-8")); saved.forEach((e: string) => UNSUBSCRIBED.add(e)); } catch {}

app.post("/unsubscribe", async (req, res) => {
  const email = (req.query.email as string || req.body?.email || "").toLowerCase().trim();
  if (email) {
    UNSUBSCRIBED.add(email);
    await writeFile(unsubPath, JSON.stringify([...UNSUBSCRIBED], null, 2));
    console.log(`[unsubscribe] ${email}`);
    recordEvent(email, "unsubscribe").catch(() => {});
  }
  res.status(200).send("OK");
});

app.get("/unsubscribe", async (req, res) => {
  const email = (req.query.email as string || "").toLowerCase().trim();
  const confirmed = req.query.confirmed === "1";
  if (email && confirmed) {
    UNSUBSCRIBED.add(email);
    await writeFile(unsubPath, JSON.stringify([...UNSUBSCRIBED], null, 2));
    console.log(`[unsubscribe] ${email}`);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title></head><body style="font-family:system-ui;background:#0a0e1a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;"><div style="text-align:center;max-width:400px;padding:40px;"><h2 style="margin:0 0 12px;">You've been unsubscribed</h2><p style="color:#94a3b8;font-size:15px;">You won't receive any more emails from Whisp. Sorry for the bother.</p></div></body></html>`);
  } else {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head><body style="font-family:system-ui;background:#0a0e1a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;"><div style="text-align:center;max-width:400px;padding:40px;"><h2 style="margin:0 0 12px;">Unsubscribe from Whisp</h2><p style="color:#94a3b8;font-size:15px;margin-bottom:24px;">Click the button below to stop receiving emails from us.</p><a href="/unsubscribe?email=${encodeURIComponent(email)}&confirmed=1" style="display:inline-block;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;text-decoration:none;">Unsubscribe</a></div></body></html>`);
  }
});

app.delete("/api/admin/unsubscribed", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  UNSUBSCRIBED.clear();
  await writeFile(unsubPath, JSON.stringify([], null, 2));
  res.json({ ok: true, cleared: true });
});

app.get("/api/admin/unsubscribed", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Forbidden" });
  res.json([...UNSUBSCRIBED]);
});

// Booking redirect - keeps all email links on whisp.so domain
app.get("/book", (_, res) => {
  res.redirect("https://cal.com/whisp/15min");
});

// Static assets
app.use(express.static(resolve(__dirname, "../public")));

// (CF token load + D1 registry hydration happen early, right after DB init above —
// the token can still be rotated by an R2 file write without a redeploy.)

// Background re-verification sweep: hasVectors() runs only once at scrape time, so
// a tenant that loses its vectors afterward (drain, corruption, over-delete) would
// otherwise stay 'active' forever. Each cycle probes a rotating slice of active+broken
// tenants and reconciles status with reality — demote confirmed-empty 'active' to
// 'broken', re-promote a 'broken' that has vectors again (self-correcting against a
// transient false negative). Conservative: small slice, rate-limited, retry-before-
// demote, and NEVER demote on a probe error.
let sweepCursor = 0;
async function sweepTenants() {
  try {
    const pool = listTenants().filter((t) => t.status === "active" || t.status === "broken");
    if (pool.length === 0) return;
    const SLICE = 40;
    const slice = pool.slice(sweepCursor, sweepCursor + SLICE);
    sweepCursor = (sweepCursor + SLICE) % pool.length;
    for (const t of slice) {
      const probe = async () => {
        try { return await new CloudflareVectorizeStore({ tenantId: t.id }).hasVectors(); }
        catch { return null; } // null = probe error -> never act on it
      };
      let ok = await probe();
      if (ok === false) { await new Promise((r) => setTimeout(r, 3000)); ok = await probe(); } // retry once (eventual consistency)
      if (ok === false && t.status === "active") {
        updateTenant(t.id, { status: "broken" });
        console.warn(`[sweep] ${t.id}: active -> broken (0 queryable vectors)`);
      } else if (ok === true && t.status === "broken") {
        updateTenant(t.id, { status: "active" });
        console.log(`[sweep] ${t.id}: broken -> active (vectors back)`);
      }
      await new Promise((r) => setTimeout(r, 200)); // rate-limit CF queries
    }
  } catch (e: any) {
    console.error(`[sweep] error: ${e?.message || e}`);
  }
}
setInterval(sweepTenants, 10 * 60 * 1000); // 40 tenants / 10 min, cycles all in a few hours

// Start server
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`[multi-tenant] Server ready on port ${port}`);
  console.log(`  Dashboard: http://localhost:${port}/dashboard`);
  console.log(`  API: http://localhost:${port}/api`);
});
// Live voice bot (Twilio ConversationRelay) shares this HTTP server for its WebSocket.
attachVoiceRelayWS(server, tenantManager);
