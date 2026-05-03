/**
 * Production server — uses Anthropic SDK (API key) instead of Claude CLI.
 * Designed for deployment on Render, Railway, etc.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY — your Anthropic API key
 *   SITE_URL — the website to scrape (e.g., https://flowstock.so)
 *
 * Optional env vars:
 *   PORT — server port (default: 3210)
 *   MAX_PAGES — max pages to scrape (default: 20)
 *   TENANT_ID — tenant identifier (default: derived from domain)
 *   BGE_HOST — BGE embedding server host (default: 176.9.1.133)
 *   BGE_PORT — BGE embedding server port (default: 7900)
 *   QDRANT_HOST — Qdrant server host (default: 152.53.243.28)
 *   QDRANT_PORT — Qdrant server port (default: 6333)
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFile, writeFile, appendFile } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import express from "express";
import cors from "cors";
import { crawlSite, closeBrowser } from "../src/scraper/index.js";
import { buildContext } from "../src/context/index.js";
import { BGEEmbeddingProvider } from "../src/embeddings/bge-provider.js";
import { QdrantVectorStore } from "../src/embeddings/qdrant-store.js";
import { embedChunks } from "../src/embeddings/pipeline.js";
import { WebsiteChat } from "../src/llm/chat.js";
import type { FlowDefinition } from "../src/context/types.js";
import {
  saveFlow,
  getFlows,
  getFlow,
  deleteFlow,
  updateFlow,
} from "../src/flows/flow-store.js";
import { executeFlow } from "../src/flows/executor.js";
import { analyzeRecordedFlow } from "../src/flows/analyzer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const url = process.env.SITE_URL;
const port = parseInt(process.env.PORT || "3210");
const maxPages = parseInt(process.env.MAX_PAGES || "20");

if (!url) {
  console.error("SITE_URL environment variable is required");
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY environment variable is required");
  process.exit(1);
}

const collection = `wctx_${(process.env.TENANT_ID || new URL(url).hostname).replace(/\./g, "_")}`;

console.log(`[website-context] Starting production server`);
console.log(`  Site: ${url}`);
console.log(`  Collection: ${collection}`);

// Step 1: Crawl
console.log(`[crawl] Scraping ${url} (max ${maxPages} pages)...`);
const crawlResult = await crawlSite(url, { maxPages, maxDepth: 3, rateLimit: 800 });
await closeBrowser();
console.log(`[crawl] ${crawlResult.stats.successPages} pages scraped`);

// Step 2: Context
const context = await buildContext(crawlResult);
await closeBrowser();
console.log(`[context] ${context.chunks.length} chunks built`);

// Step 3: Embed
const provider = new BGEEmbeddingProvider({
  host: process.env.BGE_HOST,
  port: process.env.BGE_PORT ? parseInt(process.env.BGE_PORT) : undefined,
});
const store = new QdrantVectorStore({
  host: process.env.QDRANT_HOST,
  port: process.env.QDRANT_PORT ? parseInt(process.env.QDRANT_PORT) : undefined,
  collection,
  createIfMissing: true,
});
const embedResult = await embedChunks(context.chunks, provider, store);
console.log(`[embed] ${embedResult.embeddedChunks} chunks embedded`);

// Step 4: Load flows
const tenantId = process.env.TENANT_ID || context.tenantId || "default";
context.tenantId = tenantId;
const savedFlows = await getFlows(tenantId);
const activeFlows = savedFlows.filter((f) => f.status === "active");
if (activeFlows.length > 0) {
  context.flows = activeFlows;
  console.log(`[flows] ${activeFlows.length} active flows loaded`);
}

// Step 5: Load context notes
const contextNotesPath = resolve(__dirname, `../data/${tenantId}/context_notes.json`);
let startupContextNotes: any[] = [];
if (existsSync(contextNotesPath)) {
  try {
    startupContextNotes = JSON.parse(await readFile(contextNotesPath, "utf-8"));
    console.log(`[notes] ${startupContextNotes.length} context notes loaded`);
  } catch {}
}

// Step 6: Start server
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(resolve(__dirname, "../public")));

// Use Anthropic SDK in production (not Claude CLI)
const chat = new WebsiteChat(provider, store, context, {
  llmProvider: "anthropic",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6-20250514",
});

if (startupContextNotes.length > 0) {
  chat.setContextNotes(startupContextNotes);
}

// Rate limiting
const rateLimitMap = new Map<string, { mc: number; ms: number; hc: number; hs: number }>();
function checkRate(sid: string): { ok: boolean; retry?: number } {
  const now = Date.now();
  let e = rateLimitMap.get(sid);
  if (!e) { e = { mc: 0, ms: now, hc: 0, hs: now }; rateLimitMap.set(sid, e); }
  if (now - e.ms > 60000) { e.mc = 0; e.ms = now; }
  if (now - e.hs > 3600000) { e.hc = 0; e.hs = now; }
  if (e.mc >= 20) return { ok: false, retry: Math.ceil((e.ms + 60000 - now) / 1000) };
  if (e.hc >= 100) return { ok: false, retry: Math.ceil((e.hs + 3600000 - now) / 1000) };
  e.mc++; e.hc++;
  return { ok: true };
}
setInterval(() => { const now = Date.now(); for (const [k, e] of rateLimitMap) if (now - e.hs > 3600000) rateLimitMap.delete(k); }, 600000);

// Chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, sessionId } = req.body;
    if (!messages || !Array.isArray(messages)) { res.status(400).json({ error: "messages required" }); return; }

    const sessionKey = sessionId || "default";
    const rc = checkRate(sessionKey);
    if (!rc.ok) { res.status(429).json({ error: "Rate limited", retryAfter: rc.retry }); return; }

    console.log(`[chat] "${(messages[messages.length - 1]?.content || "").slice(0, 60)}"`);
    const response = await chat.chat(messages, sessionKey);

    // Log
    try {
      const logDir = resolve(__dirname, `../data/${tenantId}`);
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      await appendFile(resolve(logDir, "conversations.jsonl"), JSON.stringify({
        sessionId: sessionKey, timestamp: new Date().toISOString(),
        userMessage: messages[messages.length - 1]?.content || "",
        botResponse: response.message,
        flowInvoked: response.flowSession?.flowId || null,
        navigatedTo: response.navigateTo || null,
        hadToolCall: !!(response.flowSession || response.navigateTo),
      }) + "\n");
    } catch {}

    res.json(response);
  } catch (error: any) {
    console.error("[error]", error.message);
    res.status(500).json({ error: "Chat failed" });
  }
});

// Health
app.get("/api/health", (_, res) => {
  res.json({ status: "ok", site: url, pages: context.pages.length, chunks: context.chunks.length, collection, activeFlows: activeFlows.length });
});

// Flows endpoints (same as serve.ts)
app.get("/api/flows", async (_, res) => { res.json(await getFlows(tenantId)); });
app.get("/api/flows/:id", async (req, res) => { const f = await getFlow(tenantId, req.params.id); f ? res.json(f) : res.status(404).json({ error: "Not found" }); });
app.put("/api/flows/:id", async (req, res) => {
  const u = await updateFlow(tenantId, req.params.id, req.body);
  if (u) { chat.loadFlows((await getFlows(tenantId)).filter((f) => f.status === "active")); res.json(u); }
  else res.status(404).json({ error: "Not found" });
});
app.delete("/api/flows/:id", async (req, res) => {
  if (await deleteFlow(tenantId, req.params.id)) { chat.loadFlows((await getFlows(tenantId)).filter((f) => f.status === "active")); res.json({ ok: true }); }
  else res.status(404).json({ error: "Not found" });
});

// Unknown questions
app.get("/api/unknown-questions", async (_, res) => {
  const fp = resolve(__dirname, `../data/${tenantId}/unknown_questions.jsonl`);
  if (!existsSync(fp)) { res.json([]); return; }
  const lines = (await readFile(fp, "utf-8")).trim().split("\n").filter(Boolean);
  const seen = new Set<string>();
  res.json(lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((q: any) => {
    if (!q) return false; const k = q.question?.toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true;
  }));
});

// Stats
app.get("/api/stats", async (_, res) => {
  let total = 0, today = 0, flows = 0, gaps = 0;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const cp = resolve(__dirname, `../data/${tenantId}/conversations.jsonl`);
  if (existsSync(cp)) {
    for (const l of (await readFile(cp, "utf-8")).trim().split("\n").filter(Boolean)) {
      try { const e = JSON.parse(l); total++; if (new Date(e.timestamp) >= todayStart) today++; if (e.flowInvoked) flows++; } catch {}
    }
  }
  const qp = resolve(__dirname, `../data/${tenantId}/unknown_questions.jsonl`);
  if (existsSync(qp)) { const s = new Set<string>(); for (const l of (await readFile(qp, "utf-8")).trim().split("\n").filter(Boolean)) { try { const q = JSON.parse(l).question?.toLowerCase(); if (q) s.add(q); } catch {} } gaps = s.size; }
  res.json({ totalConversations: total, totalToday: today, questionsAnswered: Math.max(0, total - gaps), gapsFound: gaps, flowsExecuted: flows });
});

// Context notes
app.get("/api/context-notes", async (_, res) => {
  if (!existsSync(contextNotesPath)) { res.json([]); return; }
  res.json(JSON.parse(await readFile(contextNotesPath, "utf-8")));
});
app.post("/api/context-notes", async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) { res.status(400).json({ error: "question and answer required" }); return; }
  const dir = resolve(__dirname, `../data/${tenantId}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let notes: any[] = [];
  if (existsSync(contextNotesPath)) notes = JSON.parse(await readFile(contextNotesPath, "utf-8"));
  notes.push({ question, answer, addedAt: new Date().toISOString() });
  await writeFile(contextNotesPath, JSON.stringify(notes, null, 2));
  chat.setContextNotes(notes);
  res.status(201).json(notes[notes.length - 1]);
});

// Chunks
app.get("/api/chunks", (req, res) => {
  const search = ((req.query.search as string) || "").toLowerCase();
  let chunks = context.chunks;
  if (search) chunks = chunks.filter((c) => c.content.toLowerCase().includes(search) || c.metadata.title?.toLowerCase().includes(search));
  const pageMap = new Map<string, any>();
  for (const c of chunks) {
    const pid = c.pageId || "manual";
    if (!pageMap.has(pid)) { const p = context.pages.find((p) => p.id === pid); pageMap.set(pid, { id: pid, title: p?.title || "Manual", url: p?.url || "", chunks: [] }); }
    pageMap.get(pid).chunks.push({ id: c.id, content: c.content, heading: c.metadata.headingHierarchy?.at(-1) || "", headingPath: c.metadata.headingHierarchy || [], type: c.metadata.type });
  }
  res.json({ total: chunks.length, pages: Array.from(pageMap.values()) });
});
app.put("/api/chunks/:id", (req, res) => {
  const c = context.chunks.find((c) => c.id === req.params.id);
  if (!c) { res.status(404).json({ error: "Not found" }); return; }
  c.content = req.body.content; res.json({ ok: true });
});
app.delete("/api/chunks/:id", (req, res) => {
  const i = context.chunks.findIndex((c) => c.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: "Not found" }); return; }
  context.chunks.splice(i, 1); res.json({ ok: true });
});

// Dashboard
app.get("/dashboard", (_, res) => { res.sendFile(resolve(__dirname, "../public/dashboard.html")); });

// Conversations
app.get("/api/conversations", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const fp = resolve(__dirname, `../data/${tenantId}/conversations.jsonl`);
  if (!existsSync(fp)) { res.json([]); return; }
  const lines = (await readFile(fp, "utf-8")).trim().split("\n").filter(Boolean);
  res.json(lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-limit).reverse());
});

app.listen(port, "0.0.0.0", () => {
  console.log(`[server] Ready on port ${port}`);
  console.log(`  Site: ${url} (${context.pages.length} pages, ${context.chunks.length} chunks)`);
  console.log(`  Dashboard: http://localhost:${port}/dashboard`);
});
