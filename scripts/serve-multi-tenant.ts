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
const ADMIN_SECRET = process.env.ADMIN_SECRET || "whisp-admin-2026";

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

// Claim page — "Your website already has a chatbot"
app.get("/claim", (_, res) => {
  res.sendFile(resolve(__dirname, "../public/claim/index.html"));
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
      qas.push({ q, a: resp.message.slice(0, 300) + (resp.message.length > 300 ? "..." : "") });
    } catch {
      // skip failed questions
    }
  }

  const qaHtml = qas.map(({ q, a }) => `
    <div class="qa">
      <div class="qa-q">${q}</div>
      <div class="qa-a">${a.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>")}</div>
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
    <img src="${screenshotUrl}" alt="${brand}">
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
app.get("/demo/:tenantId", (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  if (!tenant || tenant.status !== "active") {
    res.status(404).send("<!DOCTYPE html><html><body style='font-family:Archivo,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#57534e'><p>This bot is not ready yet. Check back soon.</p></body></html>");
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

  // Always use HTTPS in production (Render terminates TLS at the proxy)
  const host = req.get("host") || "website-context-dwoj.onrender.com";
  const baseUrl = process.env.BASE_URL || "https://" + host;
  const brand = tenant.brandName || tenant.domain;

  res.send('<!DOCTYPE html>\
<html lang="en">\
<head>\
<meta charset="UTF-8">\
<meta name="viewport" content="width=device-width, initial-scale=1.0">\
<title>' + brand + ' — AI Assistant by Whisp</title>\
<link rel="icon" type="image/svg+xml" href="/logo.svg">\
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Archivo:wght@400;500;600;700&display=swap" rel="stylesheet">\
<style>\
* { margin:0; padding:0; box-sizing:border-box; }\
body { font-family:"Archivo",sans-serif; background:#0a0e1a; min-height:100vh; display:flex; flex-direction:column; color:#f1f5f9; }\
.demo-header {\
  position:fixed; top:16px; left:50%; transform:translateX(-50%); z-index:50;\
  padding:10px 20px; display:flex; align-items:center; justify-content:space-between; gap:16px;\
  background:rgba(20,20,35,0.6); border:1px solid rgba(255,255,255,0.08); border-radius:16px;\
  backdrop-filter:blur(40px) saturate(1.5); -webkit-backdrop-filter:blur(40px) saturate(1.5);\
  box-shadow:0 8px 32px rgba(0,0,0,0.2);\
  animation:fadeDown 0.5s ease 0.3s both;\
}\
@keyframes fadeDown { from{opacity:0;transform:translateX(-50%) translateY(-10px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }\
.demo-brand { display:flex; align-items:center; gap:10px; }\
.demo-mark { width:22px; height:22px; }\
.demo-name { font-size:13px; font-weight:700; color:#f1f5f9; }\
.demo-badge { font-size:9px; font-weight:600; color:#3b82f6; background:rgba(59,130,246,0.1); border:1px solid rgba(59,130,246,0.2); padding:3px 8px; border-radius:8px; }\
.demo-cta {\
  padding:7px 14px; background:#3b82f6; color:#fff; border:none; border-radius:10px;\
  font-family:inherit; font-size:11px; font-weight:700; cursor:pointer; text-decoration:none;\
  transition: all 0.2s; white-space:nowrap;\
}\
.demo-cta:hover { background:#2563eb; transform:translateY(-1px); box-shadow:0 4px 16px rgba(59,130,246,0.3); }\
.demo-body { flex:1; position:relative; overflow:hidden; }\
.demo-bg { position:absolute; inset:0; z-index:0; }\
.demo-bg iframe { width:100%; height:100%; border:none; display:block; pointer-events:none; }\
.demo-bg img { width:100%; height:100%; object-fit:cover; object-position:top; display:block; }\
.demo-bg-fallback {\
  min-height:60vh; display:flex; align-items:center; justify-content:center;\
  background:linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);\
}\
.demo-bg-fallback .domain {\
  font-family:"DM Serif Display",serif; font-size:clamp(28px,5vw,48px); color:rgba(255,255,255,0.06);\
  letter-spacing:0.02em;\
}\
.demo-info {\
  position:fixed; bottom:100px; left:50%; transform:translateX(-50%);\
  background:rgba(20,20,35,0.6); border:1px solid rgba(255,255,255,0.08); border-radius:20px; padding:24px 32px;\
  backdrop-filter:blur(40px) saturate(1.5); -webkit-backdrop-filter:blur(40px) saturate(1.5);\
  box-shadow:0 8px 40px rgba(0,0,0,0.15); z-index:10; text-align:center;\
  max-width:400px; width:calc(100% - 40px); animation: fadeUp 0.5s ease 1s both;\
}\
@keyframes fadeUp { from{opacity:0;transform:translateX(-50%) translateY(10px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }\
.demo-info h3 { font-family:"DM Serif Display",serif; font-size:20px; margin-bottom:6px; color:#f1f5f9; }\
.demo-info p { font-size:14px; color:#94a3b8; line-height:1.6; margin-bottom:16px; }\
.demo-info .arrow { font-size:20px; color:#64748b; animation:bounce 1.5s ease infinite; }\
@keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(6px)} }\
.demo-dismiss { font-size:12px; color:#64748b; cursor:pointer; border:none; background:none; font-family:inherit; }\
.demo-dismiss:hover { color:#f1f5f9; }\
@media(max-width:600px) { .demo-cta { display:none; } }\
</style>\
</head>\
<body>\
<div class="demo-header">\
  <div class="demo-brand">\
    <svg class="demo-mark" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill="#3b82f6"/><path d="M8.5 11.5C8.5 9.567 10.067 8 12 8h8c1.933 0 3.5 1.567 3.5 3.5v5c0 1.933-1.567 3.5-3.5 3.5h-5l-3 2.5V20H12c-1.933 0-3.5-1.567-3.5-3.5v-5z" fill="white" opacity="0.95"/><path d="M13.5 12.5c1.5-.8 3.5-.8 5 0" stroke="#3b82f6" stroke-width="1.3" stroke-linecap="round"/><path d="M14.5 15c1-.5 2.5-.5 3 0" stroke="#3b82f6" stroke-width="1.3" stroke-linecap="round"/></svg>\
    <span class="demo-name">' + brand + '</span>\
    <span class="demo-badge">Whisp AI</span>\
  </div>\
  <a class="demo-cta" href="/">Get Whisp for your website</a>\
</div>\
<div class="demo-body">\
  <div class="demo-bg" id="demo-bg"></div>\
<script>\
(function(){\
  var bg=document.getElementById("demo-bg");\
  var img=document.createElement("img");\
  img.src="' + baseUrl + '/api/screenshot/' + tenant.id + '";\
  img.onerror=function(){bg.innerHTML=\'<div class="demo-bg-fallback"><span class="domain">' + tenant.domain + '</span></div>\';};\
  bg.appendChild(img);\
  var iframe=document.createElement("iframe");\
  iframe.src="https://' + tenant.domain + '";\
  iframe.setAttribute("sandbox","allow-same-origin");\
  iframe.style.cssText="position:absolute;inset:0;width:100%;height:100%;border:none;pointer-events:none;z-index:1;";\
  bg.appendChild(iframe);\
})();\
</script>\
  <div class="demo-info" id="demo-info">\
    <h3>Try it out!</h3>\
    <p>This AI knows everything about <strong>' + brand + '</strong>. Just start typing below to ask any question.</p>\
    <div class="arrow">↓</div>\
    <button class="demo-dismiss" onclick="document.getElementById(\'demo-info\').style.display=\'none\'">Dismiss</button>\
  </div>\
</div>\
<script>\
window.addEventListener("load", function(){\
  var c={"tenantId":"' + tenant.id + '","apiHost":"' + baseUrl + '","brandName":"' + brand.replace(/"/g, '\\"') + '","forceTheme":"dark","startExpanded":true,"demoMode":true};\
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
    .then(function(r) { return r.json(); })
    .then(function(data) {
      typing.remove();
      messages.push({ role: "assistant", content: data.message });
      addMsg("bot", data.message);
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
  const isAdmin = req.query.secret === ADMIN_SECRET;
  if (!isAdmin) {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!checkSignupRate(ip)) {
      res.status(429).json({ error: "Too many signups. Try again later." });
      return;
    }
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

    // Enqueue scrape job (priority if admin)
    if (isAdmin && req.query.priority === "1") {
      worker.enqueuePriority(tenant.id, siteUrl);
    } else {
      worker.enqueue(tenant.id, siteUrl);
    }

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

    const tenant = getTenant(tenantId);
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (tenant.status !== "active") {
      res.status(503).json({ error: "Tenant is not ready yet", status: tenant.status });
      return;
    }

    const sessionKey = sessionId || `${tenantId}_default`;
    const rc = checkChatRate(sessionKey);
    if (!rc.ok) {
      res.status(429).json({ error: "Rate limited", retryAfter: rc.retry });
      return;
    }

    const chat = await tenantManager.getChatForTenant(tenantId);
    console.log(`[chat:${tenantId}] "${(messages[messages.length - 1]?.content || "").slice(0, 60)}"`);

    {
      const response = await chat.chat(messages, sessionKey);

      const lastUserContent = messages[messages.length - 1]?.content || "";
      logMessage(tenantId, sessionKey, "user", lastUserContent).catch(() => {});
      logMessage(tenantId, sessionKey, "assistant", response.message, {
        flowInvoked: response.flowSession?.flowId || null,
        navigatedTo: response.navigateTo || null,
        hadToolCall: !!(response.flowSession || response.navigateTo),
      }).catch(() => {});

      res.json(response);
    }
  } catch (error: any) {
    console.error("[chat error]", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Chat failed" });
    }
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
  const siteUrl = (req.query.siteUrl as string) || tenant.siteUrl || `https://${tenant.domain}`;
  if (!tenant.siteUrl && siteUrl) updateTenant(tenant.id, { siteUrl });
  const priority = req.query.priority === "1" || req.query.secret === ADMIN_SECRET;
  if (priority) {
    worker.enqueuePriority(tenant.id, siteUrl, maxPages);
  } else {
    worker.enqueue(tenant.id, siteUrl, maxPages);
  }
  updateTenant(tenant.id, { status: "scraping" });
  tenantManager.evictTenant(tenant.id);
  res.json({ ok: true, status: "scraping", maxPages });
});

// Admin flush queue — stop scraping pending domains so only priority ones get scraped
app.post("/api/admin/flush-queue", (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
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

// Run business audit on all tenants + optionally send insight emails
app.post("/api/admin/audit", async (req, res) => {
  const sendEmails = req.query.send === "true";
  const limit = parseInt(req.query.limit as string) || 20;
  const allTenants = listTenants().filter(t => t.status === "active" && t.chunksCount > 0);
  const force = req.query.force === "true";
  // Only process tenants that haven't been audited yet, up to limit (unless force)
  const tenants = force
    ? allTenants.slice(0, limit)
    : allTenants.filter(t => !existsSync(resolve(__dirname, `../data/${t.id}/business-info.json`))).slice(0, limit);

  const qdrantHost = process.env.QDRANT_HOST || "152.53.243.28";
  const qdrantPort = process.env.QDRANT_PORT || "6333";

  let audited = 0;
  let withGaps = 0;
  let emailed = 0;

  for (const tenant of tenants) {
    const tenantDir = resolve(__dirname, `../data/${tenant.id}`);
    const bizInfoPath = resolve(tenantDir, "business-info.json");

    if (existsSync(bizInfoPath)) { audited++; continue; }

    try {
      const collection = `wctx_${tenant.id}`;
      const resp = await fetch(`http://${qdrantHost}:${qdrantPort}/collections/${collection}/points/scroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 100, with_payload: true }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json() as any;
      const chunks = (data.result?.points || []).map((p: any) => ({ content: p.payload?.content || "" }));
      if (chunks.length === 0) continue;

      const { auditBusinessInfo, businessInfoToNotes } = await import("../src/multi-tenant/business-audit.js");
      const bizInfo = auditBusinessInfo(chunks);
      const autoNotes = businessInfoToNotes(bizInfo);

      if (!existsSync(tenantDir)) mkdirSync(tenantDir, { recursive: true });
      await writeFile(bizInfoPath, JSON.stringify({ ...bizInfo, autoNotes, auditedAt: new Date().toISOString() }, null, 2));
      if (autoNotes.length > 0) {
        await writeFile(resolve(tenantDir, "auto-context-notes.json"), JSON.stringify(autoNotes, null, 2));
      }

      audited++;
      if (bizInfo.gaps.length > 0) withGaps++;

      if (sendEmails && bizInfo.gaps.length > 0 && tenant.email) {
        const { generateGapEmail } = await import("../src/multi-tenant/business-audit.js");
        const gapDescriptions: Record<string, string> = {
          "phone number": "Visitors looking to call you can't find your phone number easily",
          "email address": "There's no clear email contact for inquiries",
          "physical address / location": "Customers trying to visit can't find your address",
          "opening hours / business hours": "People checking when you're open get no answer",
          "pricing / rates": "Visitors want to know your prices before contacting you",
          "booking / appointment system": "There's no clear way to book online",
        };
        const insights = bizInfo.gaps.filter((g: string) => gapDescriptions[g]).slice(0, 3);
        if (insights.length > 0) {
          const demoUrl = `${process.env.BASE_URL || "https://whisp.so"}/demo/${tenant.id}`;
          const insightList = insights.map((g: string) => `<li style="padding:6px 0;color:#cbd5e1;font-size:14px;">${gapDescriptions[g]}</li>`).join("");

          try {
            const emailResp = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: process.env.EMAIL_FROM || "Jakub <jakub@whisp.so>",
                to: [tenant.email],
                reply_to: "jakub@whisp.so",
                subject: `${tenant.domain} — ${bizInfo.gaps.length} things your visitors can't find`,
                html: `<div style="font-family:system-ui;background:#0a0e1a;padding:40px 20px;"><div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;border:1px solid rgba(255,255,255,0.08);padding:40px;"><h2 style="color:#f1f5f9;font-size:20px;margin:0 0 16px;">I analyzed ${tenant.domain}</h2><p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 20px;">I ran an AI audit on your website and found ${insights.length} thing${insights.length > 1 ? "s" : ""} visitors are probably looking for but can't find:</p><ul style="list-style:none;padding:0;margin:0 0 24px;">${insightList}</ul><p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px;">I also built an AI assistant that knows your website and answers visitor questions 24/7:</p><a href="${demoUrl}" style="display:inline-block;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;text-decoration:none;">See your AI assistant</a><p style="color:#64748b;font-size:13px;margin-top:20px;">Free — no signup needed. One line of code to add to your site.</p><p style="color:#334155;font-size:11px;margin-top:28px;">Jakub — whisp.so</p></div></div>`,
              }),
            });
            if (emailResp.ok) emailed++;
          } catch {}
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } catch {}
  }

  res.json({ ok: true, audited, withGaps, emailed, total: tenants.length });
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

// Admin conversations — view chats across all or specific tenants
app.get("/api/admin/conversations", async (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
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
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
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
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
  const tenant = getTenant(req.params.tenantId);
  if (!tenant) return res.status(404).json({ error: "Not found" });
  const { status, chunksCount, pagesCount } = req.body;
  const updates: any = {};
  if (status) updates.status = status;
  if (chunksCount !== undefined) updates.chunksCount = chunksCount;
  if (pagesCount !== undefined) updates.pagesCount = pagesCount;
  updateTenant(tenant.id, updates);
  res.json({ ok: true, tenantId: tenant.id });
});

// Admin tenants list
app.get("/api/admin/tenants", (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
  const tenants = listTenants().map((t: any) => ({
    id: t.id, domain: t.domain, email: t.email, status: t.status, chunksCount: t.chunksCount,
  }));
  res.json(tenants);
});

// Admin demo visits
app.get("/api/admin/demo-visits", (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
  const n = Math.min(parseInt(req.query.n as string) || 50, DEMO_VISITS_MAX);
  const tenant = req.query.tenant as string | undefined;
  let visits = DEMO_VISITS;
  if (tenant) visits = visits.filter(v => v.tenantId === tenant);
  const unique = new Set(visits.map(v => v.tenantId));
  res.json({ total: visits.length, uniqueTenants: unique.size, visits: visits.slice(-n) });
});

// Admin logs endpoint
app.get("/api/admin/logs", (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
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
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
  UNSUBSCRIBED.clear();
  await writeFile(unsubPath, JSON.stringify([], null, 2));
  res.json({ ok: true, cleared: true });
});

app.get("/api/admin/unsubscribed", (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
  res.json([...UNSUBSCRIBED]);
});

// Booking redirect - keeps all email links on whisp.so domain
app.get("/book", (_, res) => {
  res.redirect("https://cal.com/whisp/15min");
});

// Static assets
app.use(express.static(resolve(__dirname, "../public")));

// Start server
app.listen(port, "0.0.0.0", () => {
  console.log(`[multi-tenant] Server ready on port ${port}`);
  console.log(`  Dashboard: http://localhost:${port}/dashboard`);
  console.log(`  API: http://localhost:${port}/api`);
});
