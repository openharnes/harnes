import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpManager } from "./manager.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.join(__dirname, "fixtures", "mock-server.mjs");

function withMockServer(name = "notes"): McpManager {
  return new McpManager({ [name]: { command: process.execPath, args: [MOCK_SERVER] } });
}

describe("McpManager (mock MCP stdio process)", () => {
  it("is disabled with an empty config and never spawns anything", async () => {
    const manager = new McpManager({});
    assert.equal(manager.enabled, false);
    assert.deepEqual(await manager.listTools(), []);
    await manager.close();
  });

  it("lists namespaced tools from the mock server after a real initialize handshake", async () => {
    const manager = withMockServer();
    try {
      assert.equal(manager.enabled, true);
      const tools = await manager.listTools();
      const names = tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, ["mcp__notes__read_note", "mcp__notes__search_notes", "mcp__notes__write_note"]);
      const readNote = tools.find((tool) => tool.name === "mcp__notes__read_note");
      assert.match(readNote!.description, /\[mcp:notes\]/);
      assert.match(readNote!.description, /Read a stored note/);
    } finally {
      await manager.close();
    }
  });

  it("classifies tools via annotations when present, else a name/description heuristic", async () => {
    const manager = withMockServer();
    try {
      await manager.listTools(); // populate the tool cache classify() reads from
      assert.equal(manager.classify("mcp__notes__read_note"), "read"); // annotations.readOnlyHint: true
      assert.equal(manager.classify("mcp__notes__write_note"), "write"); // annotations.destructiveHint: true
      assert.equal(manager.classify("mcp__notes__search_notes"), "read"); // no annotations; "search" keyword hint
      assert.equal(manager.classify("mcp__notes__nonexistent"), "unknown");
      assert.equal(manager.classify("not_a_namespaced_tool"), "unknown");
    } finally {
      await manager.close();
    }
  });

  it("calls a tool end to end and reflects a write in a later read", async () => {
    const manager = withMockServer();
    try {
      const before = await manager.callTool("mcp__notes__read_note", { id: "1" });
      assert.match(before, /hello from the mock MCP server/);

      const wrote = await manager.callTool("mcp__notes__write_note", { id: "2", text: "second note" });
      assert.match(wrote, /Saved note 2/);

      const after = await manager.callTool("mcp__notes__read_note", { id: "2" });
      assert.equal(after, "second note");
    } finally {
      await manager.close();
    }
  });

  it("surfaces a server-side tool error as text, not a throw", async () => {
    const manager = withMockServer();
    try {
      const result = await manager.callTool("mcp__notes__boom", {});
      assert.match(result, /MCP tool error: it broke/);
    } finally {
      await manager.close();
    }
  });

  it("returns a tool-error string (never throws) for an unconfigured server or unknown tool name", async () => {
    const manager = withMockServer();
    try {
      const badServer = await manager.callTool("mcp__ghost__whatever", {});
      assert.match(badServer, /Tool error:.*no MCP server named 'ghost'/);

      const badFormat = await manager.callTool("not_namespaced", {});
      assert.match(badFormat, /Tool error:.*not a valid/);
    } finally {
      await manager.close();
    }
  });

  it("reports connect failures as a status/tool error instead of crashing (a spawn that exits immediately)", async () => {
    const manager = new McpManager({
      broken: { command: process.execPath, args: ["-e", "process.exit(1)"] },
    });
    try {
      const result = await manager.callTool("mcp__broken__anything", {});
      assert.match(result, /Tool error: could not connect to MCP server 'broken'/);

      const statuses = await manager.describeStatus();
      assert.equal(statuses.length, 1);
      assert.equal(statuses[0].name, "broken");
      assert.equal(statuses[0].status, "error");
      assert.ok(statuses[0].detail && statuses[0].detail.length > 0);
    } finally {
      await manager.close();
    }
  });

  it("describeStatus lists connected servers with their tool classifications", async () => {
    const manager = withMockServer("docs");
    try {
      const statuses = await manager.describeStatus();
      assert.equal(statuses.length, 1);
      assert.equal(statuses[0].name, "docs");
      assert.equal(statuses[0].status, "connected");
      const byName = Object.fromEntries(statuses[0].tools.map((tool) => [tool.name, tool.class]));
      assert.equal(byName.read_note, "read");
      assert.equal(byName.write_note, "write");
    } finally {
      await manager.close();
    }
  });
});
