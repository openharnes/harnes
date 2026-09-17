import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: McpToolAnnotations;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

import { HARNES_VERSION } from "../version.ts";

const CLIENT_NAME = "harnes";
const CLIENT_VERSION = HARNES_VERSION;
const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Minimal MCP client over the stdio transport: spawns the server process and
 * speaks newline-delimited JSON-RPC 2.0 directly against its stdin/stdout.
 * No MCP SDK dependency — this repo keeps zero runtime deps beyond Node
 * builtins, and the MVP only needs `initialize` + `tools/list` + `tools/call`.
 */
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private closed = false;
  private recentStderr = "";

  constructor(
    private readonly name: string,
    private readonly config: McpServerConfig
  ) {}

  /** True when the stdio child is still running. */
  get alive(): boolean {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
  }

  /** Spawns the server process and completes the `initialize` handshake. Throws on failure; never crashes the caller. */
  async connect(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    if (this.child && this.alive) return;
    if (!this.config.command || this.config.command.trim() === "") {
      throw new Error(`MCP server '${this.name}' has no "command" configured.`);
    }

    const child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.closed = false;

    child.on("error", (error) => {
      this.failAllPending(error instanceof Error ? error : new Error(String(error)));
      this.child = undefined;
    });
    child.on("exit", (code, signal) => {
      if (!this.closed) {
        const stderrHint = this.recentStderr.trim() ? ` stderr: ${this.recentStderr.trim().slice(0, 400)}` : "";
        this.failAllPending(
          new Error(
            `MCP server '${this.name}' exited (code ${code ?? "null"}, signal ${signal ?? "null"}) before responding.${stderrHint}`
          )
        );
      }
      this.child = undefined;
    });
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.recentStderr = `${this.recentStderr}${chunk.toString("utf8")}`.slice(-2_000);
    });

    try {
      await this.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
        },
        timeoutMs
      );
    } catch (error) {
      await this.close();
      throw error;
    }
    this.notify("notifications/initialized", {});
  }

  async listTools(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpToolDef[]> {
    const result = (await this.request("tools/list", {}, timeoutMs)) as { tools?: McpToolDef[] };
    return result.tools ?? [];
  }

  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const result = (await this.request("tools/call", { name: toolName, arguments: args }, timeoutMs)) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    const body = text || "(no text content returned)";
    return result.isError ? `MCP tool error: ${body}` : body;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAllPending(new Error(`MCP client '${this.name}' closed.`));
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) {
      child.kill();
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // ignore stray non-JSON stdout noise
    }
    if (typeof message.id !== "number" && typeof message.id !== "string") return; // server notification; unused in the MVP
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message || `MCP error ${message.error.code}`));
    } else {
      waiter.resolve(message.result);
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error(`MCP client '${this.name}' is not connected.`));
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server '${this.name}' timed out waiting for '${method}' (${timeoutMs}ms).`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child) return;
    const payload: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private failAllPending(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
