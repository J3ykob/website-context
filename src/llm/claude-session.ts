import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { MCPServerConfig } from "../mcp/server.js";

export interface ClaudeSessionConfig {
  model?: string;
  systemPrompt: string;
  mcpConfig?: MCPServerConfig;
  timeout?: number;
}

interface StreamMessage {
  type: string;
  [key: string]: any;
}

export class ClaudeSession {
  private proc: ChildProcess | null = null;
  private model: string;
  private systemPrompt: string;
  private mcpConfigPath: string | null = null;
  private mcpConfig?: MCPServerConfig;
  private timeout: number;
  private buffer = "";
  private pendingResolve: ((result: { text: string; toolResults: any[] }) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private currentText = "";
  private currentToolResults: any[] = [];
  private ready = false;
  private startPromise: Promise<void> | null = null;

  constructor(config: ClaudeSessionConfig) {
    this.model = config.model || "sonnet";
    this.systemPrompt = config.systemPrompt;
    this.mcpConfig = config.mcpConfig;
    this.timeout = config.timeout || 60000;
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const args = [
      "--dangerously-skip-permissions",
      "-p",
      "--model", this.model,
      "--no-session-persistence",
      "--system-prompt", this.systemPrompt,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
    ];

    if (this.mcpConfig) {
      const tmpDir = join(tmpdir(), "wctx-mcp");
      mkdirSync(tmpDir, { recursive: true });
      this.mcpConfigPath = join(tmpDir, `mcp-session-${Date.now()}.json`);

      const mcpFileContent = {
        mcpServers: {
          "website-context": {
            command: "npx",
            args: ["tsx", join(process.cwd(), "src/mcp/server.ts")],
            env: { WCTX_CONFIG: JSON.stringify(this.mcpConfig) },
          },
        },
      };
      writeFileSync(this.mcpConfigPath, JSON.stringify(mcpFileContent));
      args.push("--mcp-config", this.mcpConfigPath, "--strict-mcp-config");
    }

    this.proc = spawn("claude", args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout!.on("data", (data) => this.onData(data.toString()));
    this.proc.stderr!.on("data", (data) => {
      // MCP server startup logs go to stderr — ignore unless it's a real error
      const msg = data.toString();
      if (msg.includes("error") || msg.includes("Error")) {
        console.error("[claude-session stderr]", msg.trim());
      }
    });

    this.proc.on("close", (code) => {
      this.ready = false;
      this.proc = null;
      if (this.pendingReject) {
        this.pendingReject(new Error(`Claude session exited with code ${code}`));
        this.pendingResolve = null;
        this.pendingReject = null;
      }
    });

    // Wait for the session to be ready (first system message)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Claude session startup timeout")), 30000);
      const check = () => {
        if (this.ready) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg: StreamMessage = JSON.parse(line);
        this.handleMessage(msg);
      } catch {}
    }
  }

  private handleMessage(msg: StreamMessage) {
    switch (msg.type) {
      case "system":
        this.ready = true;
        break;

      case "assistant":
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              this.currentText += block.text;
            } else if (block.type === "tool_use") {
              // Tool was called — we'll get the result in a tool_result message
            }
          }
        }
        break;

      case "result":
        // Final message — resolve the pending promise
        if (msg.result) {
          this.currentText = msg.result;
        }
        // Check for tool results embedded in the result
        if (msg.tool_results && Array.isArray(msg.tool_results)) {
          this.currentToolResults.push(...msg.tool_results);
        }
        if (this.pendingResolve) {
          this.pendingResolve({
            text: this.currentText.trim(),
            toolResults: this.currentToolResults,
          });
          this.pendingResolve = null;
          this.pendingReject = null;
        }
        break;
    }
  }

  async send(message: string): Promise<{ text: string; toolResults: any[] }> {
    if (!this.proc || !this.ready) {
      await this.start();
    }

    this.currentText = "";
    this.currentToolResults = [];

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      const timeoutId = setTimeout(() => {
        if (this.pendingReject) {
          this.pendingReject(new Error("Claude session response timeout"));
          this.pendingResolve = null;
          this.pendingReject = null;
        }
      }, this.timeout);

      const wrappedResolve = this.pendingResolve;
      this.pendingResolve = (result) => {
        clearTimeout(timeoutId);
        wrappedResolve!(result);
      };

      // Send the user message as stream-json
      const jsonMsg = JSON.stringify({ type: "user", content: message }) + "\n";
      this.proc!.stdin!.write(jsonMsg);
    });
  }

  async destroy(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    if (this.mcpConfigPath) {
      try { unlinkSync(this.mcpConfigPath); } catch {}
    }
    this.ready = false;
    this.startPromise = null;
  }

  isAlive(): boolean {
    return this.proc !== null && this.ready;
  }
}
