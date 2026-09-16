import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type CompletionClient } from "./loop.ts";
import type { ExecutionBackend } from "./exec/types.ts";
import { LocalBackend } from "./exec/local.ts";
import { getModel } from "./models/catalog.ts";
import { buildOpenCodeConfig } from "./opencode/config.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { isToolAllowed } from "./exec/types.ts";

const model = getModel("qwen3-coder-30b");

function memoryBackend(): ExecutionBackend & { files: Map<string, string>; commands: string[] } {
  const files = new Map<string, string>();
  const commands: string[] = [];
  return {
    mode: "local",
    files,
    commands,
    async run(command) {
      commands.push(command);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    async readFile(path) {
      return files.get(path) ?? "";
    },
    async writeFile(path, contents) {
      files.set(path, contents);
    },
    async glob() {
      return [...files.keys()];
    },
    async grep() {
      return "No matches.";
    },
    async listDir() {
      return [...files.keys()];
    },
    async close() {
      return;
    },
  };
}

describe("agent loop", () => {
  it("executes a tool then completes", async () => {
    const backend = memoryBackend();
    let step = 0;
    const complete: CompletionClient["complete"] = async () => {
      step += 1;
      if (step === 1) {
        return {
          content: "",
          toolCalls: [{ id: "1", name: "write_file", arguments: { path: "a.txt", contents: "hi" } }],
        };
      }
      return { content: "done", toolCalls: [] };
    };

    const result = await runAgentLoop({
      prompt: "write a.txt",
      model,
      backend,
      complete,
      permissionMode: "build",
    });
    assert.equal(result.stoppedReason, "complete");
    assert.equal(backend.files.get("a.txt"), "hi");
  });

  it("recovers by returning a tool error instead of throwing", async () => {
    const backend = memoryBackend();
    backend.readFile = async () => {
      throw new Error("missing");
    };
    let step = 0;
    const result = await runAgentLoop({
      prompt: "read",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return { content: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "x" } }] };
        }
        return { content: "recovered", toolCalls: [] };
      },
    });
    assert.ok(result.messages.some((message) => message.content.includes("Tool error: missing")));
    assert.equal(result.stoppedReason, "complete");
  });

  it("denies bash in plan mode", async () => {
    const result = await runAgentLoop({
      prompt: "rm -rf",
      model,
      backend: memoryBackend(),
      permissionMode: "plan",
      complete: async () => ({
        content: "",
        toolCalls: [{ id: "1", name: "bash", arguments: { command: "rm -rf /" } }],
      }),
    });
    assert.equal(result.stoppedReason, "denied-tool");
  });

  it("carries conversation history into the next turn", async () => {
    let sawPrior = false;
    await runAgentLoop({
      prompt: "follow up",
      model,
      backend: memoryBackend(),
      permissionMode: "build",
      history: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
      ],
      complete: async (input) => {
        sawPrior = input.messages.some((message) => message.content === "first");
        return { content: "second", toolCalls: [] };
      },
    });
    assert.equal(sawPrior, true);
  });
});

describe("permissions", () => {
  it("removes write tools in plan mode", () => {
    assert.equal(isToolAllowed("plan", "bash"), false);
    assert.equal(isToolAllowed("plan", "read_file"), true);
    assert.equal(isToolAllowed("build", "bash"), true);
  });

  it("allows glob, grep, and list_dir in plan mode; denies write_file and bash", () => {
    for (const tool of ["glob", "grep", "list_dir"]) {
      assert.equal(isToolAllowed("plan", tool), true, `${tool} should be allowed in plan mode`);
    }
    assert.equal(isToolAllowed("plan", "write_file"), false);
    assert.equal(isToolAllowed("plan", "bash"), false);
  });
});

describe("local backend explore tools", () => {
  async function makeWorkspace(): Promise<{ backend: LocalBackend; root: string; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(path.join(tmpdir(), "harnes-test-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export const needle = 42;\n");
    await writeFile(path.join(root, "src", "other.ts"), "export const other = 1;\n");
    await writeFile(path.join(root, "node_modules", "dep", "index.ts"), "export const needle = 0;\n");
    return { backend: new LocalBackend(root), root, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  it("glob finds workspace files and skips node_modules", async () => {
    const { backend, cleanup } = await makeWorkspace();
    try {
      const matches = await backend.glob("**/*.ts");
      assert.ok(matches.includes("src/index.ts"));
      assert.ok(matches.includes("src/other.ts"));
      assert.ok(!matches.some((match) => match.includes("node_modules")));
    } finally {
      await cleanup();
    }
  });

  it("grep finds a pattern in file contents and skips node_modules", async () => {
    const { backend, cleanup } = await makeWorkspace();
    try {
      const result = await backend.grep("needle");
      assert.match(result, /src\/index\.ts:1: export const needle = 42;/);
      assert.ok(!result.includes("node_modules"));
    } finally {
      await cleanup();
    }
  });

  it("list_dir lists directory entries", async () => {
    const { backend, cleanup } = await makeWorkspace();
    try {
      const entries = await backend.listDir("src");
      assert.deepEqual(entries, ["index.ts", "other.ts"]);
    } finally {
      await cleanup();
    }
  });

  it("rejects paths that escape the workspace root", async () => {
    const { backend, cleanup } = await makeWorkspace();
    try {
      await assert.rejects(() => backend.listDir("../"));
    } finally {
      await cleanup();
    }
  });

  it("denies glob/grep/list_dir calls in plan mode when routed through the loop", async () => {
    const { backend, cleanup } = await makeWorkspace();
    try {
      const result = await runAgentLoop({
        prompt: "explore",
        model,
        backend,
        permissionMode: "plan",
        complete: async () => ({
          content: "",
          toolCalls: [{ id: "1", name: "write_file", arguments: { path: "x.txt", contents: "no" } }],
        }),
      });
      assert.equal(result.stoppedReason, "denied-tool");
    } finally {
      await cleanup();
    }
  });
});

describe("OpenCode distribution", () => {
  it("emits OpenCode config with open-model defaults", () => {
    const config = buildOpenCodeConfig(DEFAULT_CONFIG);
    assert.equal(config.$schema, "https://opencode.ai/config.json");
    assert.match(String(config.model), /qwen3-coder:30b/);
    assert.match(String(config.small_model), /qwen3-coder:8b/);
  });

  it("emits OpenRouter model ids when provider is openrouter", () => {
    const config = buildOpenCodeConfig({
      ...DEFAULT_CONFIG,
      provider: "openrouter",
      openaiCompatible: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-x" },
    });
    assert.match(String(config.model), /qwen\/qwen3-coder/);
  });
});
