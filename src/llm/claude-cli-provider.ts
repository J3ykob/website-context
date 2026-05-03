import { spawn } from "child_process";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FlowDefinition, SiteMapEntry } from "../context/types.js";
import type { MCPServerConfig } from "../mcp/server.js";

export interface ClaudeCLIConfig {
  mode: "local" | "ssh";
  sshHost?: string;
  model?: string; // "sonnet", "opus", "haiku"
  timeout?: number;
}

export interface MCPToolResult {
  action: string;
  flow_id?: string;
  flow_name?: string;
  inputs?: Record<string, string>;
  steps?: any[];
  url?: string;
  reason?: string;
  question?: string;
  logged?: boolean;
}

export interface GenerateWithToolsResult {
  text: string;
  toolResults: MCPToolResult[];
}

export class ClaudeCLIProvider {
  private mode: "local" | "ssh";
  private sshHost: string;
  private model: string;
  private timeout: number;

  constructor(config: ClaudeCLIConfig = { mode: "local" }) {
    this.mode = config.mode;
    this.sshHost = config.sshHost || "";
    this.model = config.model || "sonnet";
    this.timeout = config.timeout || 60000;
  }

  async generate(system: string, userMessage: string): Promise<string> {
    const fullPrompt = `${system}\n\n---\n\n${userMessage}`;

    if (this.mode === "local") {
      return this.callLocal(fullPrompt, []);
    } else {
      return this.callSSH(fullPrompt);
    }
  }

  async generateStructured<T>(system: string, userMessage: string, schema: object): Promise<T> {
    const fullPrompt = `${system}\n\n---\n\n${userMessage}`;
    const extraArgs = ["--json-schema", JSON.stringify(schema), "--output-format", "json"];
    const raw = await this.callLocal(fullPrompt, extraArgs);
    try {
      const parsed = JSON.parse(raw);
      // CLI wraps structured output in an envelope: {structured_output: {...}, result: "", ...}
      if (parsed.structured_output) {
        return parsed.structured_output as T;
      }
      if (parsed.result && typeof parsed.result === "string" && parsed.result.length > 0) {
        return JSON.parse(parsed.result) as T;
      }
      return parsed as T;
    } catch {
      // If JSON parse fails, try to extract JSON from the raw text
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]) as T;
      throw new Error("Failed to parse structured output: " + raw.slice(0, 200));
    }
  }

  private callLocal(prompt: string, extraArgs: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "--dangerously-skip-permissions",
        "-p",
        "--model", this.model,
        "--no-session-persistence",
        "--system-prompt", "You are a website assistant. Follow the instructions in the user prompt.",
        ...extraArgs,
      ];
      if (!extraArgs.some((a) => a === "--output-format")) {
        args.push("--output-format", "text");
      }
      const proc = spawn("claude", args, {
        timeout: this.timeout,
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.stderr.on("data", (data) => { stderr += data.toString(); });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Claude CLI spawn error: ${err.message}`));
      });

      // Write prompt to stdin
      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }

  private callSSH(prompt: string): Promise<string> {
    if (!this.sshHost) throw new Error("sshHost required for SSH mode");

    return new Promise((resolve, reject) => {
      const proc = spawn("ssh", [
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=no",
        this.sshHost,
        `claude -p --output-format text --model ${this.model} --no-session-persistence`,
      ], {
        timeout: this.timeout + 10000,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.stderr.on("data", (data) => { stderr += data.toString(); });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Claude CLI (SSH) exited with code ${code}: ${stderr}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`SSH spawn error: ${err.message}`));
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }

  /**
   * Generate a response using MCP tools exposed to the Claude CLI.
   * Spawns `claude -p` with `--mcp-config` pointing to our MCP server.
   */
  async generateWithTools(
    systemPrompt: string,
    userMessage: string,
    mcpConfig: MCPServerConfig
  ): Promise<GenerateWithToolsResult> {
    // Write MCP config to a temp file (--mcp-config takes a file path)
    const tmpDir = join(tmpdir(), "wctx-mcp");
    mkdirSync(tmpDir, { recursive: true });
    const ts = Date.now();
    const configPath = join(tmpDir, `mcp-config-${ts}.json`);
    const resultPath = join(tmpDir, `mcp-results-${ts}.jsonl`);
    writeFileSync(resultPath, "");

    const mcpFileContent = {
      mcpServers: {
        "website-context": {
          command: "npx",
          args: ["tsx", join(process.cwd(), "src/mcp/server.ts")],
          env: {
            WCTX_CONFIG: JSON.stringify({ ...mcpConfig, resultPath }),
          },
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(mcpFileContent));

    // MCP calls need more time (server startup + tool execution)
    const savedTimeout = this.timeout;
    this.timeout = Math.max(this.timeout, 120000);

    try {
      const raw = await this.callLocal(
        `${systemPrompt}\n\n---\n\n${userMessage}`,
        [
          "--mcp-config", configPath,
          "--strict-mcp-config",
          "--output-format", "json",
        ]
      );

      // Extract text from the JSON envelope
      let text = "";
      try {
        const parsed = JSON.parse(raw);
        text = parsed.result || "";
      } catch {
        text = raw;
      }

      // Read tool results from the side-channel file (MCP server wrote them there)
      const toolResults: MCPToolResult[] = [];
      try {
        const { readFileSync } = await import("fs");
        const resultData = readFileSync(resultPath, "utf-8").trim();
        if (resultData) {
          for (const line of resultData.split("\n")) {
            if (line.trim()) {
              toolResults.push(JSON.parse(line));
            }
          }
        }
      } catch {}

      console.log("[mcp] text:", text.slice(0, 80), "| tools:", toolResults.length, toolResults.map(t => t.action).join(","));
      return { text, toolResults };
    } finally {
      this.timeout = savedTimeout;
      try { unlinkSync(configPath); } catch {}
      try { unlinkSync(resultPath); } catch {}
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await new Promise((resolve) => {
        const proc = spawn(
          this.mode === "local" ? "claude" : "ssh",
          this.mode === "local"
            ? ["--version"]
            : ["-o", "ConnectTimeout=5", this.sshHost, "claude --version"],
          { timeout: 10000 }
        );
        proc.on("close", (code) => resolve(code === 0));
        proc.on("error", () => resolve(false));
      });
    } catch {
      return false;
    }
  }
}
