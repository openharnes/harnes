#!/usr/bin/env node
// Minimal MCP stdio server fixture for tests: speaks newline-delimited
// JSON-RPC 2.0 and implements just enough of the protocol (initialize,
// tools/list, tools/call) to exercise McpStdioClient / McpManager without a
// real third-party server. Plain Node (no deps, no TypeScript) so it can be
// spawned directly as a child process.

import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "read_note",
    description: "Read a stored note by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_note",
    description: "Create or overwrite a stored note.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "search_notes",
    // No annotations on purpose: exercises the name/description keyword heuristic (read hint "search").
    description: "Search stored notes by keyword.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
];

const notes = new Map([["1", "hello from the mock MCP server"]]);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request) {
  const { id, method, params } = request;
  if (method === "notifications/initialized") return; // no response for notifications

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp-server", version: "0.0.1" },
      },
    });
    return;
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params ?? {};
    if (name === "read_note") {
      const text = notes.get(String(args?.id ?? "")) ?? "(no such note)";
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      return;
    }
    if (name === "write_note") {
      notes.set(String(args?.id ?? ""), String(args?.text ?? ""));
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Saved note ${args?.id}` }] } });
      return;
    }
    if (name === "search_notes") {
      const query = String(args?.query ?? "");
      const hits = [...notes.entries()].filter(([, text]) => text.includes(query)).map(([noteId]) => noteId);
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: hits.join(",") || "(no matches)" }] } });
      return;
    }
    if (name === "boom") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "it broke" }], isError: true } });
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool ${name}` } });
    return;
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handle(JSON.parse(trimmed));
  } catch {
    // ignore malformed input
  }
});
