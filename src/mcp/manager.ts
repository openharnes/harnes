import { MCP_TOOL_PREFIX, type McpToolClass } from "../exec/types.ts";
import { McpStdioClient, type McpServerConfig, type McpToolDef } from "./client.ts";

export type { McpServerConfig };

/** Tool surface `runAgentLoop` / the REPL need from MCP — kept small and easy to fake in tests. */
export interface McpToolProvider {
  /** Namespaced `mcp__<server>__<tool>` defs for every server that connects successfully. Never throws. */
  listTools(): Promise<{ name: string; description: string }[]>;
  /** read/write/unknown classification for a namespaced tool, used for permission gating. */
  classify(namespacedName: string): McpToolClass;
  /** Calls a namespaced tool. Connection/call failures are returned as an error string, never thrown. */
  callTool(namespacedName: string, args: Record<string, string>): Promise<string>;
  /** Per-server status for the `/mcp` slash command. Connects lazily if not already connected. */
  describeStatus(): Promise<McpServerStatus[]>;
  close(): Promise<void>;
}

export interface McpServerStatus {
  name: string;
  status: "connected" | "error";
  detail?: string;
  tools: { name: string; class: McpToolClass }[];
}

const WRITE_HINTS = /\b(write|create|delete|remove|update|modify|set|put|post|send|publish|commit|push|deploy|insert|drop|rename|move|execute|run|apply|patch|edit)\b/i;
const READ_HINTS = /\b(get|list|read|fetch|search|find|query|describe|show|view|status|info)\b/i;

/**
 * Classifies a tool as read/write/unknown for permission gating. Prefers the
 * MCP spec's `annotations.readOnlyHint` / `destructiveHint` when the server
 * provides them; otherwise falls back to a keyword heuristic on name +
 * description. When neither signal is present, returns "unknown" — callers
 * treat unknown like write in plan mode and always prompt for it in ask mode.
 */
export function classifyMcpTool(def: McpToolDef): McpToolClass {
  if (def.annotations?.readOnlyHint === true) return "read";
  if (def.annotations?.destructiveHint === true) return "write";
  if (def.annotations?.readOnlyHint === false) return "write";
  const haystack = `${def.name} ${def.description ?? ""}`;
  if (WRITE_HINTS.test(haystack)) return "write";
  if (READ_HINTS.test(haystack)) return "read";
  return "unknown";
}

interface ServerState {
  config: McpServerConfig;
  client?: McpStdioClient;
  tools?: McpToolDef[];
  error?: string;
  connecting?: Promise<void>;
}

/**
 * Owns lazily-connected MCP stdio clients for every server configured under
 * `mcpServers` in ~/.config/harnes/config.json. Namespaces each server's
 * tools as `mcp__<server>__<tool>` for the model, and never lets a bad or
 * unreachable server crash the loop: connect/list/call failures surface as
 * tool-result text or a `/mcp` status line, not exceptions.
 *
 * "Lazy connect on first use": no server is spawned at construction time —
 * only when `listTools`/`callTool`/`describeStatus` is actually called (the
 * first agent turn that needs the tool schema, an explicit MCP tool call, or
 * an explicit `/mcp`).
 */
export class McpManager implements McpToolProvider {
  private readonly servers = new Map<string, ServerState>();

  constructor(configs: Record<string, McpServerConfig> = {}) {
    for (const [name, config] of Object.entries(configs)) {
      this.servers.set(name, { config });
    }
  }

  /** True when at least one MCP server is configured. The REPL skips wiring MCP into the loop entirely when false. */
  get enabled(): boolean {
    return this.servers.size > 0;
  }

  get serverNames(): string[] {
    return [...this.servers.keys()];
  }

  async listTools(): Promise<{ name: string; description: string }[]> {
    if (!this.enabled) return [];
    const out: { name: string; description: string }[] = [];
    await Promise.all(
      this.serverNames.map(async (name) => {
        const tools = await this.ensureTools(name);
        for (const tool of tools) {
          out.push({
            name: `${MCP_TOOL_PREFIX}${name}__${tool.name}`,
            description: `[mcp:${name}] ${tool.description ?? tool.name}`,
          });
        }
      })
    );
    return out;
  }

  classify(namespacedName: string): McpToolClass {
    const parsed = this.parseName(namespacedName);
    if (!parsed) return "unknown";
    const def = this.servers.get(parsed.server)?.tools?.find((tool) => tool.name === parsed.tool);
    return def ? classifyMcpTool(def) : "unknown";
  }

  async callTool(namespacedName: string, args: Record<string, string>): Promise<string> {
    const parsed = this.parseName(namespacedName);
    if (!parsed) {
      return `Tool error: '${namespacedName}' is not a valid mcp__<server>__<tool> name.`;
    }
    const state = this.servers.get(parsed.server);
    if (!state) {
      return `Tool error: no MCP server named '${parsed.server}' is configured.`;
    }
    try {
      await this.ensureConnected(parsed.server);
    } catch (error) {
      return `Tool error: could not connect to MCP server '${parsed.server}': ${errorMessage(error)}`;
    }
    try {
      return await state.client!.callTool(parsed.tool, args);
    } catch (error) {
      return `Tool error: MCP call to '${namespacedName}' failed: ${errorMessage(error)}`;
    }
  }

  async describeStatus(): Promise<McpServerStatus[]> {
    return Promise.all(
      this.serverNames.map(async (name): Promise<McpServerStatus> => {
        const tools = await this.ensureTools(name);
        const state = this.servers.get(name)!;
        if (state.error) return { name, status: "error", detail: state.error, tools: [] };
        return {
          name,
          status: "connected",
          tools: tools.map((tool) => ({ name: tool.name, class: classifyMcpTool(tool) })),
        };
      })
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((state) => state.client?.close()));
  }

  /** Lazily connects (once, cached) and returns this server's tool list; returns [] (never throws) on failure. */
  private async ensureTools(name: string): Promise<McpToolDef[]> {
    const state = this.servers.get(name);
    if (!state) return [];
    if (state.tools) return state.tools;
    try {
      await this.ensureConnected(name);
      const tools = await state.client!.listTools();
      state.tools = tools;
      state.error = undefined;
      return tools;
    } catch (error) {
      state.error = errorMessage(error);
      return [];
    }
  }

  /** Spawns + initializes a server's client exactly once; concurrent callers share the in-flight connect. */
  private async ensureConnected(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`No MCP server named '${name}' is configured.`);
    if (state.client) return;
    if (!state.connecting) {
      const client = new McpStdioClient(name, state.config);
      state.connecting = client
        .connect()
        .then(() => {
          state.client = client;
          state.error = undefined;
        })
        .catch((error) => {
          state.error = errorMessage(error);
          state.connecting = undefined;
          throw error;
        });
    }
    await state.connecting;
  }

  private parseName(namespacedName: string): { server: string; tool: string } | undefined {
    if (!namespacedName.startsWith(MCP_TOOL_PREFIX)) return undefined;
    const rest = namespacedName.slice(MCP_TOOL_PREFIX.length);
    const sep = rest.indexOf("__");
    if (sep === -1) return undefined;
    return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
