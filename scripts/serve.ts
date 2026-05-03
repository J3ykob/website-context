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

const url = process.argv[2];
const maxPages = parseInt(process.argv[3] || "10");
const port = parseInt(process.argv[4] || "3210");

if (!url) {
  console.log("Usage: npx tsx scripts/serve.ts <website-url> [maxPages] [port]");
  console.log("Example: npx tsx scripts/serve.ts https://vite.dev 10 3210");
  process.exit(1);
}

const collection = `wctx_demo_${new URL(url).hostname.replace(/\./g, "_")}`;

console.log(`\n╔══════════════════════════════════════════════════════╗`);
console.log(`║   Website Context — Serve Mode                        ║`);
console.log(`╚══════════════════════════════════════════════════════╝\n`);

// Step 1: Crawl
console.log(`➤ Crawling ${url} (max ${maxPages} pages)...`);
const crawlResult = await crawlSite(url, { maxPages, maxDepth: 3, rateLimit: 800 });
await closeBrowser();
console.log(`  ✓ ${crawlResult.stats.successPages} pages\n`);

// Step 2: Context
console.log(`➤ Building context...`);
const context = await buildContext(crawlResult);
await closeBrowser();
console.log(`  ✓ ${context.chunks.length} chunks\n`);

// Step 3: Embed
console.log(`➤ Embedding (BGE → Qdrant collection: ${collection})...`);
const provider = new BGEEmbeddingProvider();
const store = new QdrantVectorStore({ collection, createIfMissing: true });
const embedResult = await embedChunks(context.chunks, provider, store);
console.log(`  ✓ ${embedResult.embeddedChunks} chunks embedded\n`);

// Step 4: Load saved flows
const tenantId = context.tenantId || "default";
console.log(`➤ Loading saved flows for tenant "${tenantId}"...`);
const savedFlows = await getFlows(tenantId);
const activeFlows = savedFlows.filter((f) => f.status === "active");
if (activeFlows.length > 0) {
  context.flows = activeFlows;
  console.log(`  ✓ ${activeFlows.length} active flows loaded\n`);
} else {
  console.log(`  (no active flows found)\n`);
}

// Step 4b: Load context notes
const contextNotesPath = resolve(__dirname, `../data/${tenantId}/context_notes.json`);
if (existsSync(contextNotesPath)) {
  try {
    const notesContent = await readFile(contextNotesPath, "utf-8");
    const contextNotes = JSON.parse(notesContent);
    console.log(`➤ Loading context notes...`);
    console.log(`  ✓ ${contextNotes.length} notes loaded\n`);
    // Will be passed to chat after initialization
    var startupContextNotes = contextNotes;
  } catch {
    var startupContextNotes: any[] = [];
  }
} else {
  var startupContextNotes: any[] = [];
}

// Step 5: Serve
console.log(`➤ Starting API server...\n`);

// --- Rate Limiting ---
interface RateLimitEntry {
  minuteCount: number;
  minuteStart: number;
  hourCount: number;
  hourStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_PER_MINUTE = 20;
const RATE_LIMIT_PER_HOUR = 100;

function checkRateLimit(sessionId: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  let entry = rateLimitMap.get(sessionId);

  if (!entry) {
    entry = { minuteCount: 0, minuteStart: now, hourCount: 0, hourStart: now };
    rateLimitMap.set(sessionId, entry);
  }

  // Reset minute window
  if (now - entry.minuteStart > 60_000) {
    entry.minuteCount = 0;
    entry.minuteStart = now;
  }

  // Reset hour window
  if (now - entry.hourStart > 3_600_000) {
    entry.hourCount = 0;
    entry.hourStart = now;
  }

  // Check minute limit
  if (entry.minuteCount >= RATE_LIMIT_PER_MINUTE) {
    const retryAfter = Math.ceil((entry.minuteStart + 60_000 - now) / 1000);
    return { allowed: false, retryAfter };
  }

  // Check hour limit
  if (entry.hourCount >= RATE_LIMIT_PER_HOUR) {
    const retryAfter = Math.ceil((entry.hourStart + 3_600_000 - now) / 1000);
    return { allowed: false, retryAfter };
  }

  entry.minuteCount++;
  entry.hourCount++;
  return { allowed: true };
}

// Clean up stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now - entry.hourStart > 3_600_000) {
      rateLimitMap.delete(key);
    }
  }
}, 600_000);

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Serve static files
app.use(express.static(resolve(__dirname, "../public")));

// Chat endpoint
const chat = new WebsiteChat(provider, store, context, {
  llmProvider: "claude-cli",
  claudeCli: { mode: "local", model: "sonnet" },
});

// Load context notes into chat
if (startupContextNotes && startupContextNotes.length > 0) {
  chat.setContextNotes(startupContextNotes);
}

app.post("/api/chat", async (req, res) => {
  try {
    const { messages, sessionId } = req.body;
    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: "messages array required" });
      return;
    }

    const sessionKey = sessionId || "default";

    // Rate limiting
    const rateCheck = checkRateLimit(sessionKey);
    if (!rateCheck.allowed) {
      res.status(429).json({
        error: "Too many messages. Please wait before sending more.",
        retryAfter: rateCheck.retryAfter,
      });
      return;
    }

    const lastUserMessage = messages[messages.length - 1]?.content || "";
    console.log(`  [chat] "${lastUserMessage.slice(0, 60)}..."`);
    const response = await chat.chat(messages, sessionKey);

    // Log conversation entry
    try {
      const logDir = resolve(__dirname, `../data/${tenantId}`);
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      const logEntry = JSON.stringify({
        sessionId: sessionKey,
        timestamp: new Date().toISOString(),
        userMessage: lastUserMessage,
        botResponse: response.message,
        flowInvoked: response.flowSession?.flowId || null,
        navigatedTo: response.navigateTo || null,
        hadToolCall: !!(response.flowSession || response.navigateTo),
      }) + "\n";
      await appendFile(resolve(logDir, "conversations.jsonl"), logEntry);
    } catch (logErr) {
      // Don't fail the response if logging fails
    }

    res.json(response);
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Chat failed" });
  }
});

// ─── Flow Management Endpoints ─────────────────────────────────────────────

// Save a new recorded flow
app.post("/api/flows", async (req, res) => {
  try {
    const flowTenantId = (req.query.tenantId as string) || tenantId;
    const flowData = req.body as FlowDefinition;

    if (!flowData.id || !flowData.steps) {
      res.status(400).json({ error: "Flow must have id and steps" });
      return;
    }

    if (!flowData.createdAt) flowData.createdAt = new Date().toISOString();
    if (!flowData.updatedAt) flowData.updatedAt = new Date().toISOString();
    if (!flowData.status) flowData.status = "draft";
    if (!flowData.triggerPhrases) flowData.triggerPhrases = [];
    if (!flowData.requiredInputs) flowData.requiredInputs = [];

    const saved = await saveFlow(flowTenantId, flowData);

    if (saved.status === "active") {
      const allFlows = await getFlows(flowTenantId);
      chat.loadFlows(allFlows.filter((f) => f.status === "active"));
    }

    console.log(`  [flow] Saved: ${saved.id} (${saved.steps.length} steps)`);
    res.status(201).json(saved);
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to save flow" });
  }
});

// Recorder.js POST endpoint — auto-analyzes with LLM before saving
app.post("/api/flows/record", async (req, res) => {
  try {
    const flowTenantId = (req.query.tenantId as string) || tenantId;
    const rawData = req.body;

    if (!rawData.id || !rawData.steps) {
      res.status(400).json({ error: "Flow must have id and steps" });
      return;
    }

    console.log(`  [flow] Analyzing recording (${rawData.steps.length} raw steps)...`);

    // LLM analyzes the raw recording: parameterizes inputs, generates triggers, names the skill
    const { flow: analyzedFlow, summary } = await analyzeRecordedFlow({
      id: rawData.id,
      steps: rawData.steps,
      startUrl: rawData.startUrl || rawData.steps[0]?.url || "",
      recordedAt: rawData.recordedAt || new Date().toISOString(),
    });

    const saved = await saveFlow(flowTenantId, analyzedFlow);

    // Auto-load as active skill
    const allFlows = await getFlows(flowTenantId);
    chat.loadFlows(allFlows.filter((f) => f.status === "active"));

    console.log(`  [flow] Skill created: "${saved.name}" (${saved.requiredInputs.length} params, ${saved.triggerPhrases.length} triggers)`);
    console.log(`  [flow] ${summary}`);
    res.status(201).json({ flow: saved, summary });
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to save recorded flow" });
  }
});

// List flows
app.get("/api/flows", async (req, res) => {
  try {
    const flowTenantId = (req.query.tenantId as string) || tenantId;
    const flows = await getFlows(flowTenantId);
    res.json(flows);
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to list flows" });
  }
});

// Get specific flow
app.get("/api/flows/:id", async (req, res) => {
  try {
    const flowTenantId = (req.query.tenantId as string) || tenantId;
    const flow = await getFlow(flowTenantId, req.params.id);
    if (!flow) {
      res.status(404).json({ error: "Flow not found" });
      return;
    }
    res.json(flow);
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to get flow" });
  }
});

// Update flow
app.put("/api/flows/:id", async (req, res) => {
  try {
    const flowTenantId = (req.query.tenantId as string) || tenantId;
    const updates = req.body as Partial<Pick<FlowDefinition, "name" | "description" | "triggerPhrases" | "status">>;

    const updated = await updateFlow(flowTenantId, req.params.id, updates);
    if (!updated) {
      res.status(404).json({ error: "Flow not found" });
      return;
    }

    // Reload active flows into chat
    const allFlows = await getFlows(flowTenantId);
    chat.loadFlows(allFlows.filter((f) => f.status === "active"));

    res.json(updated);
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to update flow" });
  }
});

// Delete flow
app.delete("/api/flows/:id", async (req, res) => {
  try {
    const flowTenantId = (req.query.tenantId as string) || tenantId;
    const deleted = await deleteFlow(flowTenantId, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Flow not found" });
      return;
    }

    const allFlows = await getFlows(flowTenantId);
    chat.loadFlows(allFlows.filter((f) => f.status === "active"));

    res.json({ success: true });
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to delete flow" });
  }
});

// Execute flow
app.post("/api/flows/:id/execute", async (req, res) => {
  try {
    const flowTenantId = (req.query.tenantId as string) || tenantId;
    const { inputs } = req.body as { inputs?: Record<string, string> };

    const flow = await getFlow(flowTenantId, req.params.id);
    if (!flow) {
      res.status(404).json({ error: "Flow not found" });
      return;
    }

    console.log(`  [flow] Executing: ${flow.id} (${flow.name})`);
    const result = await executeFlow(flow, {
      inputs: inputs || {},
      headless: true,
      defaultTimeout: 15000,
    });

    res.json(result);
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to execute flow" });
  }
});

// Test-run flow (with screenshots)
app.post("/api/flows/:id/test", async (req, res) => {
  try {
    const flowTenantId = (req.query.tenantId as string) || tenantId;
    const { inputs } = req.body as { inputs?: Record<string, string> };

    const flow = await getFlow(flowTenantId, req.params.id);
    if (!flow) {
      res.status(404).json({ error: "Flow not found" });
      return;
    }

    console.log(`  [flow] Test-running: ${flow.id} (${flow.name})`);
    const result = await executeFlow(flow, {
      inputs: inputs || {},
      headless: true,
      screenshots: true,
      screenshotDir: `./data/${flowTenantId}/screenshots/${flow.id}`,
      defaultTimeout: 15000,
    });

    await updateFlow(flowTenantId, flow.id, {});

    res.json(result);
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to test flow" });
  }
});

// ─── Flow Recorder (proxy-based, works in any browser) ──────────────────────

app.get("/record", (req, res) => {
  const targetUrl = req.query.url as string;
  const host = `http://localhost:${port}`;

  // Build links for each scraped page
  const pageLinks = context.pages.map((p) => {
    const pageUrl = p.url + (p.url.includes("?") ? "&" : "?") + "wctx-record=true";
    return '<a class="page-link" href="' + pageUrl + '">' + (p.title || p.url) + ' <span>→</span></a>';
  }).join("\n      ");

  res.setHeader("Content-Type", "text/html");
  res.send('<!DOCTYPE html>\
<html><head><title>Flow Recorder</title>\
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&display=swap" rel="stylesheet">\
<style>\
*{margin:0;padding:0;box-sizing:border-box}\
body{font-family:"Archivo",-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa}\
.card{background:#fff;border-radius:20px;padding:48px;max-width:560px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.08);border:1px solid rgba(0,0,0,0.06)}\
h1{font-size:20px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:8px}\
p{color:#666;font-size:14px;margin-bottom:20px;line-height:1.6}\
.input-row{display:flex;gap:8px;margin-bottom:32px}\
input{flex:1;padding:16px 20px;border:1.5px solid #0a0a0a;border-radius:12px;font-family:inherit;font-size:15px;font-weight:500;outline:none}\
input::placeholder{color:#c4c4c4}\
input:focus{box-shadow:0 0 0 3px rgba(10,10,10,0.06)}\
button{padding:16px 28px;background:#0a0a0a;color:#fff;border:none;border-radius:12px;font-family:inherit;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;cursor:pointer;transition:opacity 0.2s}\
button:hover{opacity:0.8}\
h3{font-size:11px;text-transform:uppercase;letter-spacing:0.14em;color:#999;font-weight:600;margin-bottom:12px}\
.pages{display:flex;flex-direction:column;gap:6px;margin-bottom:28px}\
.page-link{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border:1px solid #eee;border-radius:10px;text-decoration:none;color:#0a0a0a;font-size:13px;font-weight:500;transition:all 0.2s}\
.page-link:hover{background:#f5f5f5;border-color:#ccc}\
.page-link span{color:#999;font-size:16px}\
.or{text-align:center;color:#ccc;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;margin:20px 0}\
.hint{background:#f8f8f8;border-radius:10px;padding:16px 20px;font-size:12px;color:#888;line-height:1.7}\
.hint code{background:#eee;padding:2px 6px;border-radius:4px;font-size:11px}\
</style></head>\
<body>\
<div class="card">\
  <h1>Flow Recorder</h1>\
  <p>Click any page below to open it with the recorder active. Click through the process you want to automate, then hit Stop.</p>\
  <h3>Site pages</h3>\
  <div class="pages">\
      ' + pageLinks + '\
  </div>\
  <div class="or">or enter any URL</div>\
  <form class="input-row" onsubmit="event.preventDefault();var u=document.getElementById(\'u\').value;if(u.indexOf(\'?\')>-1)u+=\'&wctx-record=true\';else u+=\'?wctx-record=true\';window.location.href=u">\
    <input id="u" type="url" placeholder="https://your-site.com/page" required />\
    <button type="submit">Record</button>\
  </form>\
  <div class="hint">\
    The recorder activates when <code>?wctx-record=true</code> is in the URL. After recording, the LLM auto-analyzes your actions into a parameterized skill that the chatbot can execute.\
  </div>\
</div>\
</body></html>');
});

// Health check
app.get("/api/health", (_, res) => {
  res.json({
    status: "ok",
    site: url,
    pages: context.pages.length,
    chunks: context.chunks.length,
    collection,
    activeFlows: activeFlows.length,
  });
});

// ─── Unknown Questions Endpoints ──────────────────────────────────────────────

app.get("/api/unknown-questions", async (req, res) => {
  try {
    const qTenantId = (req.query.tenantId as string) || tenantId;
    const filePath = resolve(__dirname, `../data/${qTenantId}/unknown_questions.jsonl`);
    if (!existsSync(filePath)) {
      res.json([]);
      return;
    }
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const all = lines.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    // Deduplicate by question text
    const seen = new Set<string>();
    const questions = all.filter((q: any) => {
      const key = q.question?.toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    res.json(questions);
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to read unknown questions" });
  }
});

app.delete("/api/unknown-questions", async (req, res) => {
  try {
    const qTenantId = (req.query.tenantId as string) || tenantId;
    const filePath = resolve(__dirname, `../data/${qTenantId}/unknown_questions.jsonl`);
    if (existsSync(filePath)) {
      await writeFile(filePath, "", "utf-8");
    }
    res.json({ success: true });
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to clear unknown questions" });
  }
});

// ─── Conversations Endpoint ───────────────────────────────────────────────────

app.get("/api/conversations", async (req, res) => {
  try {
    const cTenantId = (req.query.tenantId as string) || tenantId;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const filePath = resolve(__dirname, `../data/${cTenantId}/conversations.jsonl`);
    if (!existsSync(filePath)) {
      res.json([]);
      return;
    }
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const conversations = lines
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .slice(-limit)
      .reverse();
    res.json(conversations);
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to read conversations" });
  }
});

// ─── Stats Endpoint ───────────────────────────────────────────────────────────

app.get("/api/stats", async (req, res) => {
  try {
    const sTenantId = (req.query.tenantId as string) || tenantId;
    const convoPath = resolve(__dirname, `../data/${sTenantId}/conversations.jsonl`);
    const questionsPath = resolve(__dirname, `../data/${sTenantId}/unknown_questions.jsonl`);

    let totalConversations = 0;
    let totalToday = 0;
    let flowsExecuted = 0;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    if (existsSync(convoPath)) {
      const content = await readFile(convoPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      totalConversations = lines.length;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (new Date(entry.timestamp) >= todayStart) totalToday++;
          if (entry.flowInvoked) flowsExecuted++;
        } catch {}
      }
    }

    let gapsFound = 0;
    if (existsSync(questionsPath)) {
      const qContent = await readFile(questionsPath, "utf-8");
      const qLines = qContent.trim().split("\n").filter(Boolean);
      const qSeen = new Set<string>();
      for (const line of qLines) {
        try {
          const q = JSON.parse(line).question?.toLowerCase().trim();
          if (q) qSeen.add(q);
        } catch {}
      }
      gapsFound = qSeen.size;
    }

    res.json({
      totalConversations,
      totalToday,
      questionsAnswered: Math.max(0, totalConversations - gapsFound),
      gapsFound,
      flowsExecuted,
    });
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to compute stats" });
  }
});

// ─── Context Notes Endpoints ──────────────────────────────────────────────────

app.get("/api/context-notes", async (req, res) => {
  try {
    const nTenantId = (req.query.tenantId as string) || tenantId;
    const filePath = resolve(__dirname, `../data/${nTenantId}/context_notes.json`);
    if (!existsSync(filePath)) {
      res.json([]);
      return;
    }
    const content = await readFile(filePath, "utf-8");
    res.json(JSON.parse(content));
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to read context notes" });
  }
});

app.post("/api/context-notes", async (req, res) => {
  try {
    const nTenantId = (req.query.tenantId as string) || tenantId;
    const { question, answer } = req.body;
    if (!question || !answer) {
      res.status(400).json({ error: "question and answer required" });
      return;
    }

    const filePath = resolve(__dirname, `../data/${nTenantId}/context_notes.json`);
    const dir = resolve(__dirname, `../data/${nTenantId}`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let notes: any[] = [];
    if (existsSync(filePath)) {
      const content = await readFile(filePath, "utf-8");
      notes = JSON.parse(content);
    }

    notes.push({ question, answer, addedAt: new Date().toISOString() });
    await writeFile(filePath, JSON.stringify(notes, null, 2), "utf-8");

    // Reload context notes into the chat system prompt
    chat.setContextNotes(notes);

    console.log(`  [context-note] Added: "${question.slice(0, 40)}..."`);
    res.status(201).json(notes[notes.length - 1]);
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to save context note" });
  }
});

app.delete("/api/context-notes/:index", async (req, res) => {
  try {
    const nTenantId = (req.query.tenantId as string) || tenantId;
    const index = parseInt(req.params.index);
    const filePath = resolve(__dirname, `../data/${nTenantId}/context_notes.json`);

    if (!existsSync(filePath)) {
      res.status(404).json({ error: "No notes found" });
      return;
    }

    const content = await readFile(filePath, "utf-8");
    const notes: any[] = JSON.parse(content);

    if (index < 0 || index >= notes.length) {
      res.status(404).json({ error: "Note index out of range" });
      return;
    }

    notes.splice(index, 1);
    await writeFile(filePath, JSON.stringify(notes, null, 2), "utf-8");

    // Reload context notes into the chat system prompt
    chat.setContextNotes(notes);

    res.json({ success: true });
  } catch (error: any) {
    console.error("  [error]", error.message);
    res.status(500).json({ error: "Failed to delete context note" });
  }
});

// ─── Knowledge Chunks Endpoints ─────────────────────────────────────────────

app.get("/api/chunks", (req, res) => {
  const search = (req.query.search as string || "").toLowerCase();

  let chunks = context.chunks;
  if (search) {
    chunks = chunks.filter((c) =>
      c.content.toLowerCase().includes(search) ||
      c.metadata.title?.toLowerCase().includes(search) ||
      c.metadata.headingHierarchy?.some((h: string) => h.toLowerCase().includes(search))
    );
  }

  // Group chunks by page
  const pageMap = new Map<string, { id: string; title: string; url: string; chunks: any[] }>();

  for (const c of chunks) {
    const pid = c.pageId || "manual";
    if (!pageMap.has(pid)) {
      const pageInfo = context.pages.find((p) => p.id === pid);
      pageMap.set(pid, {
        id: pid,
        title: pageInfo?.title || (pid === "manual" ? "Manual entries" : "Unknown page"),
        url: pageInfo?.url || c.metadata.url || "",
        chunks: [],
      });
    }
    pageMap.get(pid)!.chunks.push({
      id: c.id,
      content: c.content,
      heading: c.metadata.headingHierarchy?.length
        ? c.metadata.headingHierarchy[c.metadata.headingHierarchy.length - 1]
        : "",
      headingPath: c.metadata.headingHierarchy || [],
      type: c.metadata.type,
    });
  }

  const pages = Array.from(pageMap.values()).sort((a, b) => {
    if (a.id === "manual") return 1;
    if (b.id === "manual") return -1;
    return a.title.localeCompare(b.title);
  });

  res.json({ total: chunks.length, pages });
});

app.put("/api/chunks/:id", (req, res) => {
  const { content } = req.body;
  if (!content || typeof content !== "string") {
    res.status(400).json({ error: "content string required" });
    return;
  }

  const chunk = context.chunks.find((c) => c.id === req.params.id);
  if (!chunk) {
    res.status(404).json({ error: "Chunk not found" });
    return;
  }

  chunk.content = content;
  console.log("  [chunk] Updated:", req.params.id.slice(0, 8), "(" + content.length + " chars)");
  res.json({ success: true, id: chunk.id });
});

app.delete("/api/chunks/:id", (req, res) => {
  const idx = context.chunks.findIndex((c) => c.id === req.params.id);
  if (idx === -1) {
    res.status(404).json({ error: "Chunk not found" });
    return;
  }

  context.chunks.splice(idx, 1);
  console.log("  [chunk] Deleted:", req.params.id.slice(0, 8));
  res.json({ success: true });
});

app.post("/api/chunks", (req, res) => {
  const { content, title, url: chunkUrl, type } = req.body;
  if (!content) {
    res.status(400).json({ error: "content required" });
    return;
  }

  const { randomUUID } = require("crypto");
  const newChunk = {
    id: randomUUID(),
    pageId: "manual",
    content,
    metadata: {
      url: chunkUrl || url,
      title: title || "Manual entry",
      headingHierarchy: [],
      type: type || "content",
    },
  };

  context.chunks.push(newChunk as any);
  console.log("  [chunk] Added manual:", newChunk.id.slice(0, 8));
  res.status(201).json({ success: true, id: newChunk.id });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

app.get("/dashboard", (_, res) => {
  res.sendFile(resolve(__dirname, "../public/dashboard.html"));
});

// ─── Site Context Endpoint ────────────────────────────────────────────────────

app.get("/api/context", (_, res) => {
  res.json({
    tenantId,
    site: url,
    pages: context.pages.map((p) => ({
      id: p.id,
      url: p.url,
      title: p.title,
      description: p.description,
      lastScraped: p.lastScraped,
    })),
    chunks: context.chunks.length,
    flows: activeFlows.length,
  });
});

app.listen(port, () => {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Ready! Open in browser:`);
  console.log(`  http://localhost:${port}/test.html`);
  console.log(`  http://localhost:${port}/dashboard`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`\n  Site: ${url} (${context.pages.length} pages, ${context.chunks.length} chunks)`);
  console.log(`  Flows: ${activeFlows.length} active`);
  console.log(`  Recorder bookmarklet: http://localhost:${port}/api/recorder/bookmarklet`);
  console.log(`  Chat widget embedded on the test page.`);
  console.log(`  Ask questions about the website in the chat bubble!\n`);
});
