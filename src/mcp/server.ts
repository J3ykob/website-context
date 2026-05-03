/**
 * MCP Server for website-context
 *
 * Runs as a stdio-based MCP server spawned by the Claude CLI via --mcp-config.
 * Exposes website flows, navigation, and unknown-question logging as tools.
 *
 * Configuration is passed via the WCTX_CONFIG environment variable (JSON).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import type { FlowDefinition, SiteMapEntry } from "../context/types.js";

// --- Config from environment ---

export interface MCPServerConfig {
  tenantId: string;
  flows: FlowDefinition[];
  siteMap: SiteMapEntry[];
  resultPath?: string; // temp file to write tool results to
  allowedDomain?: string; // domain whitelist for navigation
}

function loadConfig(): MCPServerConfig {
  const raw = process.env.WCTX_CONFIG;
  if (!raw) {
    throw new Error("WCTX_CONFIG environment variable is required");
  }
  return JSON.parse(raw) as MCPServerConfig;
}

// --- Server setup ---

function emitResult(config: MCPServerConfig, data: any) {
  if (config.resultPath) {
    try {
      appendFileSync(config.resultPath, JSON.stringify(data) + "\n");
    } catch {}
  }
}

async function main() {
  const config = loadConfig();

  const server = new McpServer({
    name: "website-context",
    version: "1.0.0",
  });

  // --- Domain validation helper ---

  const allowedDomain = config.allowedDomain || extractDomain(config.siteMap);

  function isUrlAllowed(urlStr: string): { allowed: boolean; reason?: string } {
    // Block dangerous protocols
    const lower = urlStr.trim().toLowerCase();
    if (lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("file:")) {
      return { allowed: false, reason: `Blocked: "${lower.split(":")[0]}:" protocol URLs are not allowed` };
    }

    if (!allowedDomain) {
      // No domain restriction configured — allow all http(s)
      return { allowed: true };
    }

    try {
      const parsed = new URL(urlStr);
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
      const domainNormalized = allowedDomain.toLowerCase().replace(/^www\./, "");
      if (hostname === domainNormalized || hostname.endsWith("." + domainNormalized)) {
        return { allowed: true };
      }
      return { allowed: false, reason: `Blocked: URL domain "${parsed.hostname}" does not match allowed domain "${allowedDomain}"` };
    } catch {
      return { allowed: false, reason: "Blocked: Invalid URL format" };
    }
  }

  // --- Static tools ---

  server.tool(
    "navigate_to_page",
    "Navigate the user's browser to a specific page on the website",
    {
      url: z.string().describe("The full URL to navigate to"),
      reason: z.string().describe("Why the user should be taken to this page"),
    },
    async ({ url, reason }) => {
      const validation = isUrlAllowed(url);
      if (!validation.allowed) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ action: "navigate", error: validation.reason }) }],
        };
      }

      const result = { action: "navigate", url, reason };
      emitResult(config, result);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  server.tool(
    "log_unknown_question",
    "Log a question the chatbot couldn't answer from the available website context. Use this when the user asks something not covered by the site content.",
    {
      question: z.string().describe("The question that couldn't be answered"),
    },
    async ({ question }) => {
      try {
        const dir = "data/" + (config.tenantId || "default");
        mkdirSync(dir, { recursive: true });
        const entry =
          JSON.stringify({
            question,
            timestamp: new Date().toISOString(),
          }) + "\n";
        appendFileSync(dir + "/unknown_questions.jsonl", entry);
      } catch {
        // Swallow file errors in the MCP server
      }
      const result = { action: "log_unknown", question, logged: true };
      emitResult(config, result);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // --- Dynamic flow tools (one per active flow) ---

  const activeFlows = config.flows.filter((f) => f.status === "active");

  for (const flow of activeFlows) {
    const toolName = `flow_${sanitizeToolName(flow.id)}`;

    // Build zod schema from requiredInputs
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const input of flow.requiredInputs) {
      let fieldSchema: z.ZodTypeAny = z.string().describe(
        `${input.label}: ${input.description || input.type}${input.validation ? " (pattern: " + input.validation + ")" : ""}`
      );
      if (!input.required) {
        fieldSchema = fieldSchema.optional();
      }
      shape[input.name] = fieldSchema;
    }

    server.tool(
      toolName,
      flow.description || flow.name,
      shape,
      async (inputs) => {
        const result = {
          action: "invoke_flow",
          flow_id: flow.id,
          flow_name: flow.name,
          inputs,
          steps: flow.steps,
        };
        emitResult(config, result);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      }
    );
  }

  // --- Start server with stdio transport ---

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function sanitizeToolName(id: string): string {
  // MCP tool names must be alphanumeric + underscores
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

function extractDomain(siteMap: SiteMapEntry[]): string | undefined {
  if (siteMap.length === 0) return undefined;
  try {
    return new URL(siteMap[0].url).hostname;
  } catch {
    return undefined;
  }
}

main().catch((err) => {
  process.stderr.write(`MCP server fatal error: ${err}\n`);
  process.exit(1);
});
