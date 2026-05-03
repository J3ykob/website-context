import express from "express";
import cors from "cors";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { BGEEmbeddingProvider } from "../embeddings/bge-provider.js";
import { QdrantVectorStore } from "../embeddings/qdrant-store.js";
import { WebsiteChat } from "../llm/chat.js";
import type { WebsiteContext, FlowDefinition } from "../context/types.js";
import {
  saveFlow,
  getFlows,
  getFlow,
  deleteFlow,
  updateFlow,
} from "../flows/flow-store.js";
import { executeFlow } from "../flows/executor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface APIServerConfig {
  port?: number;
  context: WebsiteContext;
  collection: string;
}

export function createAPIServer(config: APIServerConfig) {
  const { port = 3210, context, collection } = config;
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

  // Serve the widget JS
  app.get("/widget.js", (_, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.sendFile(resolve(__dirname, "../../dist/widget/widget.js"));
  });

  // Serve test page
  app.get("/test", (_, res) => {
    res.setHeader("Content-Type", "text/html");
    res.sendFile(resolve(__dirname, "../../public/test.html"));
  });

  const embeddingProvider = new BGEEmbeddingProvider();
  const store = new QdrantVectorStore({ collection, createIfMissing: true });
  const chat = new WebsiteChat(embeddingProvider, store, context, {
    llmProvider: "claude-cli",
    claudeCli: { mode: "local", model: "sonnet" },
  });

  // Load saved flows at startup
  (async () => {
    const tenantId = context.tenantId || "default";
    const flows = await getFlows(tenantId);
    const activeFlows = flows.filter((f) => f.status === "active");
    if (activeFlows.length > 0) {
      chat.loadFlows(activeFlows);
      console.log(`[API] Loaded ${activeFlows.length} active flows for tenant ${tenantId}`);
    }
  })();

  // Chat endpoint
  app.post("/api/chat", async (req, res) => {
    try {
      const { messages, tenantId, sessionId } = req.body;

      if (!messages || !Array.isArray(messages)) {
        res.status(400).json({ error: "messages array required" });
        return;
      }

      const sessionKey = sessionId || tenantId || "default";
      const response = await chat.chat(messages, sessionKey);
      res.json(response);
    } catch (error) {
      console.error("[API] Chat error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── Flow Management Endpoints ─────────────────────────────────────────────

  // Save a new recorded flow (from recorder.js)
  app.post("/api/flows", async (req, res) => {
    try {
      const tenantId = (req.query.tenantId as string) || req.body.tenantId || "default";
      const flowData = req.body as FlowDefinition;

      if (!flowData.id || !flowData.steps) {
        res.status(400).json({ error: "Flow must have id and steps" });
        return;
      }

      // Ensure timestamps
      if (!flowData.createdAt) flowData.createdAt = new Date().toISOString();
      if (!flowData.updatedAt) flowData.updatedAt = new Date().toISOString();
      if (!flowData.status) flowData.status = "draft";
      if (!flowData.triggerPhrases) flowData.triggerPhrases = [];
      if (!flowData.requiredInputs) flowData.requiredInputs = [];

      const saved = await saveFlow(tenantId, flowData);

      // If flow is active, reload flows into chat context
      if (saved.status === "active") {
        const allFlows = await getFlows(tenantId);
        chat.loadFlows(allFlows.filter((f) => f.status === "active"));
      }

      console.log(`[API] Flow saved: ${saved.id} (${saved.steps.length} steps)`);
      res.status(201).json(saved);
    } catch (error) {
      console.error("[API] Save flow error:", error);
      res.status(500).json({ error: "Failed to save flow" });
    }
  });

  // Also support the recorder.js POST endpoint path
  app.post("/api/flows/record", async (req, res) => {
    try {
      const tenantId = (req.query.tenantId as string) || "default";
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

      const saved = await saveFlow(tenantId, flowData);
      console.log(`[API] Flow recorded: ${saved.id} (${saved.steps.length} steps)`);
      res.status(201).json(saved);
    } catch (error) {
      console.error("[API] Record flow error:", error);
      res.status(500).json({ error: "Failed to save recorded flow" });
    }
  });

  // List flows for a tenant
  app.get("/api/flows", async (req, res) => {
    try {
      const tenantId = (req.query.tenantId as string) || "default";
      const flows = await getFlows(tenantId);
      res.json(flows);
    } catch (error) {
      console.error("[API] List flows error:", error);
      res.status(500).json({ error: "Failed to list flows" });
    }
  });

  // Get specific flow
  app.get("/api/flows/:id", async (req, res) => {
    try {
      const tenantId = (req.query.tenantId as string) || "default";
      const flow = await getFlow(tenantId, req.params.id);
      if (!flow) {
        res.status(404).json({ error: "Flow not found" });
        return;
      }
      res.json(flow);
    } catch (error) {
      console.error("[API] Get flow error:", error);
      res.status(500).json({ error: "Failed to get flow" });
    }
  });

  // Update flow (name, triggers, status)
  app.put("/api/flows/:id", async (req, res) => {
    try {
      const tenantId = (req.query.tenantId as string) || "default";
      const updates = req.body as Partial<Pick<FlowDefinition, "name" | "description" | "triggerPhrases" | "status">>;

      const updated = await updateFlow(tenantId, req.params.id, updates);
      if (!updated) {
        res.status(404).json({ error: "Flow not found" });
        return;
      }

      // Reload active flows into chat context
      const allFlows = await getFlows(tenantId);
      chat.loadFlows(allFlows.filter((f) => f.status === "active"));

      res.json(updated);
    } catch (error) {
      console.error("[API] Update flow error:", error);
      res.status(500).json({ error: "Failed to update flow" });
    }
  });

  // Delete flow
  app.delete("/api/flows/:id", async (req, res) => {
    try {
      const tenantId = (req.query.tenantId as string) || "default";
      const deleted = await deleteFlow(tenantId, req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "Flow not found" });
        return;
      }

      // Reload active flows
      const allFlows = await getFlows(tenantId);
      chat.loadFlows(allFlows.filter((f) => f.status === "active"));

      res.json({ success: true });
    } catch (error) {
      console.error("[API] Delete flow error:", error);
      res.status(500).json({ error: "Failed to delete flow" });
    }
  });

  // Execute a flow with provided input values
  app.post("/api/flows/:id/execute", async (req, res) => {
    try {
      const tenantId = (req.query.tenantId as string) || "default";
      const { inputs } = req.body as { inputs?: Record<string, string> };

      const flow = await getFlow(tenantId, req.params.id);
      if (!flow) {
        res.status(404).json({ error: "Flow not found" });
        return;
      }

      console.log(`[API] Executing flow: ${flow.id} (${flow.name})`);
      const result = await executeFlow(flow, {
        inputs: inputs || {},
        headless: true,
        defaultTimeout: 15000,
      });

      res.json(result);
    } catch (error) {
      console.error("[API] Execute flow error:", error);
      res.status(500).json({ error: "Failed to execute flow" });
    }
  });

  // Test-run a flow (same as execute but with screenshots)
  app.post("/api/flows/:id/test", async (req, res) => {
    try {
      const tenantId = (req.query.tenantId as string) || "default";
      const { inputs } = req.body as { inputs?: Record<string, string> };

      const flow = await getFlow(tenantId, req.params.id);
      if (!flow) {
        res.status(404).json({ error: "Flow not found" });
        return;
      }

      console.log(`[API] Test-running flow: ${flow.id} (${flow.name})`);
      const result = await executeFlow(flow, {
        inputs: inputs || {},
        headless: true,
        screenshots: true,
        screenshotDir: `./data/${tenantId}/screenshots/${flow.id}`,
        defaultTimeout: 15000,
      });

      // Update lastTestedAt
      await updateFlow(tenantId, flow.id, {});

      res.json(result);
    } catch (error) {
      console.error("[API] Test flow error:", error);
      res.status(500).json({ error: "Failed to test flow" });
    }
  });

  // ─── Recorder Bookmarklet ──────────────────────────────────────────────────

  app.get("/api/recorder/bookmarklet", (req, res) => {
    const host = req.query.host || `http://localhost:${port}`;
    const bookmarklet = `javascript:(function(){var s=document.createElement('script');s.src='${host}/recorder.js';document.head.appendChild(s)})()`;

    res.setHeader("Content-Type", "text/html");
    res.send(`<!DOCTYPE html>
<html>
<head><title>Flow Recorder Bookmarklet</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; line-height: 1.6; color: #1a1a2e; }
h1 { font-size: 24px; margin-bottom: 8px; }
p { color: #555; }
.bookmarklet { display: inline-block; background: #1a1a2e; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 20px 0; }
.bookmarklet:hover { background: #2a2a4e; }
code { background: #f0f0f5; padding: 3px 8px; border-radius: 4px; font-size: 13px; }
.instructions { background: #f8f8fc; border: 1px solid #e0e0e8; border-radius: 12px; padding: 20px 24px; margin-top: 24px; }
.instructions ol { padding-left: 20px; }
.instructions li { margin-bottom: 8px; }
</style>
</head>
<body>
<h1>Flow Recorder</h1>
<p>Drag this button to your bookmarks bar:</p>
<a class="bookmarklet" href="${bookmarklet}">Record Flow</a>
<div class="instructions">
<h3>Instructions</h3>
<ol>
<li>Drag the <strong>Record Flow</strong> button above to your bookmarks bar.</li>
<li>Navigate to any website where you want to record a flow.</li>
<li>Click the bookmarklet to start recording.</li>
<li>Perform the actions you want to automate (click, type, navigate).</li>
<li>Click <strong>Stop &amp; Save</strong> when done.</li>
<li>The recorded flow will be saved to this server at <code>${host}/api/flows/record</code>.</li>
</ol>
<p><strong>Note:</strong> Make sure this server is running at <code>${host}</code> when you record.</p>
</div>
</body>
</html>`);
  });

  // Health check
  app.get("/api/health", (_, res) => {
    res.json({ status: "ok", collection, pages: context.pages.length, chunks: context.chunks.length });
  });

  const server = app.listen(port, () => {
    console.log(`[API] Server running at http://localhost:${port}`);
    console.log(`[API] Test page: http://localhost:${port}/test`);
    console.log(`[API] Widget JS: http://localhost:${port}/widget.js`);
    console.log(`[API] Health: http://localhost:${port}/api/health`);
    console.log(`[API] Flow recorder bookmarklet: http://localhost:${port}/api/recorder/bookmarklet`);
    console.log(`[API] Flows API: http://localhost:${port}/api/flows`);
  });

  return server;
}
