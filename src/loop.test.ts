import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type CompletionClient } from "./loop.ts";
import type { McpToolProvider } from "./mcp/manager.ts";
import type { ExecutionBackend } from "./exec/types.ts";
import { LocalBackend } from "./exec/local.ts";
import { getModel } from "./models/catalog.ts";
import { buildOpenCodeConfig } from "./opencode/config.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { isToolAllowed, needsApproval } from "./exec/types.ts";

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
    async editFile(path, oldString, newString, replaceAll) {
      const contents = files.get(path);
      if (contents === undefined) throw new Error(`File not found: ${path}`);
      const occurrences = contents.split(oldString).length - 1;
      if (occurrences === 0) throw new Error(`old_string not found in ${path}`);
      if (occurrences > 1 && !replaceAll) throw new Error(`old_string matches ${occurrences} locations in ${path}`);
      files.set(path, replaceAll ? contents.split(oldString).join(newString) : contents.replace(oldString, newString));
      return { replacements: occurrences };
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
    async gitStatus() {
      return "(clean working tree)";
    },
    async gitDiff() {
      return "(no changes)";
    },
    async gitLog() {
      return "(no commits)";
    },
    async gitCommit(message) {
      if (!message.trim()) throw new Error("Commit message must not be empty.");
      return { commit: "abc1234", summary: `1 file changed` };
    },
    async runCheck(options) {
      const command = options?.command ?? `npm run ${options?.script ?? "test"}`;
      commands.push(command);
      return { exitCode: 0, passed: true, summary: `PASSED: ${command} (exit 0)`, output: "ok", command };
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

  it("edits a file via edit_file (exact replace)", async () => {
    const backend = memoryBackend();
    backend.files.set("a.txt", "hello world");
    let step = 0;
    const result = await runAgentLoop({
      prompt: "edit a.txt",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "1", name: "edit_file", arguments: { path: "a.txt", old_string: "world", new_string: "there" } },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.equal(backend.files.get("a.txt"), "hello there");
    assert.ok(result.messages.some((message) => message.content.includes("Edited a.txt")));
  });

  it("surfaces a tool error when edit_file's old_string is not found", async () => {
    const backend = memoryBackend();
    backend.files.set("a.txt", "hello world");
    let step = 0;
    const result = await runAgentLoop({
      prompt: "edit a.txt",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "1", name: "edit_file", arguments: { path: "a.txt", old_string: "nope", new_string: "x" } },
            ],
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.ok(result.messages.some((message) => message.content.includes("old_string not found")));
    assert.equal(backend.files.get("a.txt"), "hello world");
  });

  it("surfaces a tool error when edit_file's old_string is ambiguous", async () => {
    const backend = memoryBackend();
    backend.files.set("a.txt", "foo foo foo");
    let step = 0;
    const result = await runAgentLoop({
      prompt: "edit a.txt",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "1", name: "edit_file", arguments: { path: "a.txt", old_string: "foo", new_string: "bar" } },
            ],
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.ok(result.messages.some((message) => message.content.includes("matches 3 locations")));
    assert.equal(backend.files.get("a.txt"), "foo foo foo");
  });

  it("write_file still works for creating new files", async () => {
    const backend = memoryBackend();
    let step = 0;
    const result = await runAgentLoop({
      prompt: "create b.txt",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "write_file", arguments: { path: "b.txt", contents: "new file" } }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.equal(backend.files.get("b.txt"), "new file");
  });

  it("denies edit_file in plan mode", async () => {
    const result = await runAgentLoop({
      prompt: "edit a.txt",
      model,
      backend: memoryBackend(),
      permissionMode: "plan",
      complete: async () => ({
        content: "",
        toolCalls: [{ id: "1", name: "edit_file", arguments: { path: "a.txt", old_string: "x", new_string: "y" } }],
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

describe("parallel tool execution", () => {
  it("runs independent tool calls in the same step concurrently (overlap)", async () => {
    const backend = memoryBackend();
    let active = 0;
    let maxActive = 0;
    backend.run = async (command) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      // Yield so both calls are in-flight at once before either resolves.
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { exitCode: 0, stdout: command, stderr: "" };
    };
    let step = 0;
    const result = await runAgentLoop({
      prompt: "run two commands",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "1", name: "bash", arguments: { command: "echo a" } },
              { id: "2", name: "bash", arguments: { command: "echo b" } },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.ok(maxActive >= 2, `expected overlap, got maxActive=${maxActive}`);
  });

  it("preserves model call order in the transcript regardless of completion order", async () => {
    const backend = memoryBackend();
    backend.run = async (command) => {
      // Second call ("echo b") finishes before the first ("echo a").
      const delay = command === "echo a" ? 20 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { exitCode: 0, stdout: command, stderr: "" };
    };
    let step = 0;
    const result = await runAgentLoop({
      prompt: "run two commands",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "1", name: "bash", arguments: { command: "echo a" } },
              { id: "2", name: "bash", arguments: { command: "echo b" } },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    assert.equal(toolMessages[0]?.tool_call_id, "1");
    assert.ok(toolMessages[0]?.content.includes("echo a"));
    assert.equal(toolMessages[1]?.tool_call_id, "2");
    assert.ok(toolMessages[1]?.content.includes("echo b"));
  });

  it("fires onProgress once per tool call in a parallel step", async () => {
    const backend = memoryBackend();
    const progressed: string[] = [];
    let step = 0;
    await runAgentLoop({
      prompt: "run two commands",
      model,
      backend,
      permissionMode: "build",
      onProgress: (event) => {
        if (event.type === "tool") progressed.push(event.name);
      },
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "1", name: "bash", arguments: { command: "echo a" } },
              { id: "2", name: "bash", arguments: { command: "echo b" } },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(progressed.length, 2);
    assert.deepEqual(progressed, ["bash", "bash"]);
  });

  it("a denied call fails only itself and does not cancel an already-kicked-off sibling", async () => {
    const backend = memoryBackend();
    let step = 0;
    const result = await runAgentLoop({
      prompt: "write and denied bash",
      model,
      backend,
      permissionMode: "build",
      onApprove: async (call) => call.name !== "bash",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "1", name: "write_file", arguments: { path: "a.txt", contents: "hi" } },
              { id: "2", name: "bash", arguments: { command: "echo denied" } },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "denied-tool");
    // The sibling write_file call still ran even though bash was denied.
    assert.equal(backend.files.get("a.txt"), "hi");
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    assert.equal(toolMessages[0]?.tool_call_id, "1");
    assert.ok(toolMessages[0]?.content.includes("Wrote a.txt"));
    assert.equal(toolMessages[1]?.tool_call_id, "2");
    assert.ok(toolMessages[1]?.content.includes("User denied tool bash"));
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

  it("denies edit_file in plan mode, allows it in build mode", () => {
    assert.equal(isToolAllowed("plan", "edit_file"), false);
    assert.equal(isToolAllowed("build", "edit_file"), true);
  });

  it("allows todo_write in both plan and build mode", () => {
    assert.equal(isToolAllowed("plan", "todo_write"), true);
    assert.equal(isToolAllowed("build", "todo_write"), true);
  });

  it("does not require ask-on-edit approval for todo_write (not a mutating edit)", () => {
    assert.equal(needsApproval("ask", "todo_write"), false);
    assert.equal(needsApproval("auto", "todo_write"), false);
  });

  it("treats edit_file like write_file for approval prompts", () => {
    assert.equal(needsApproval("ask", "edit_file"), true);
    assert.equal(needsApproval("ask", "write_file"), true);
    assert.equal(needsApproval("manual", "edit_file"), true);
    assert.equal(needsApproval("auto", "edit_file"), false);
  });

  it("allows git_status/git_diff/git_log in plan mode; denies git_commit", () => {
    for (const tool of ["git_status", "git_diff", "git_log"]) {
      assert.equal(isToolAllowed("plan", tool), true, `${tool} should be allowed in plan mode`);
    }
    assert.equal(isToolAllowed("plan", "git_commit"), false);
    assert.equal(isToolAllowed("build", "git_commit"), true);
  });

  it("treats git_commit like write_file for approval prompts", () => {
    assert.equal(needsApproval("ask", "git_commit"), true);
    assert.equal(needsApproval("manual", "git_commit"), true);
    assert.equal(needsApproval("auto", "git_commit"), false);
  });

  it("allows run_tests in build mode; denies it in plan mode", () => {
    assert.equal(isToolAllowed("build", "run_tests"), true);
    assert.equal(isToolAllowed("plan", "run_tests"), false);
  });

  it("does not require ask-on-edit approval for run_tests (verify step, not a mutation)", () => {
    assert.equal(needsApproval("ask", "run_tests"), false);
    assert.equal(needsApproval("auto", "run_tests"), false);
    assert.equal(needsApproval("manual", "run_tests"), true);
  });
});

describe("git tools wiring in the loop", () => {
  it("routes git_status/git_diff/git_log tool calls to the backend", async () => {
    const backend = memoryBackend();
    backend.gitStatus = async () => "## main\nM a.txt";
    backend.gitDiff = async (filePath) => (filePath ? `diff for ${filePath}` : "diff for all");
    backend.gitLog = async (maxCount) => `log capped at ${maxCount ?? "default"}`;
    let step = 0;
    const result = await runAgentLoop({
      prompt: "check git state",
      model,
      backend,
      permissionMode: "plan",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "1", name: "git_status", arguments: {} },
              { id: "2", name: "git_diff", arguments: { path: "a.txt" } },
              { id: "3", name: "git_log", arguments: { max_count: "5" } },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.ok(result.messages.some((m) => m.content === "## main\nM a.txt"));
    assert.ok(result.messages.some((m) => m.content === "diff for a.txt"));
    assert.ok(result.messages.some((m) => m.content === "log capped at 5"));
  });

  it("denies git_commit in plan mode", async () => {
    const result = await runAgentLoop({
      prompt: "commit",
      model,
      backend: memoryBackend(),
      permissionMode: "plan",
      complete: async () => ({
        content: "",
        toolCalls: [{ id: "1", name: "git_commit", arguments: { message: "wip" } }],
      }),
    });
    assert.equal(result.stoppedReason, "denied-tool");
  });

  it("commits with an explicit message in build mode", async () => {
    const backend = memoryBackend();
    let seenOptions: { stageAll?: boolean } | undefined;
    backend.gitCommit = async (message, options) => {
      seenOptions = options;
      return { commit: "deadbee", summary: "1 file changed" };
    };
    let step = 0;
    const result = await runAgentLoop({
      prompt: "commit my change",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "git_commit", arguments: { message: "Fix the bug" } }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.ok(result.messages.some((m) => m.content.includes("Committed deadbee")));
    assert.equal(seenOptions?.stageAll, true);
  });

  it("passes stage_all=false through to the backend", async () => {
    const backend = memoryBackend();
    let seenOptions: { stageAll?: boolean } | undefined;
    backend.gitCommit = async (message, options) => {
      seenOptions = options;
      return { commit: "deadbee", summary: "" };
    };
    let step = 0;
    await runAgentLoop({
      prompt: "commit staged only",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "git_commit", arguments: { message: "wip", stage_all: "false" } }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(seenOptions?.stageAll, false);
  });

  it("surfaces a clear tool error when git_commit's message is empty", async () => {
    const backend = memoryBackend();
    let step = 0;
    const result = await runAgentLoop({
      prompt: "commit with no message",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return { content: "", toolCalls: [{ id: "1", name: "git_commit", arguments: {} }] };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.ok(result.messages.some((m) => m.content.includes("Tool error: Commit message must not be empty.")));
  });
});

describe("run_tests tool wiring in the loop", () => {
  it("routes a run_tests call to the backend and reports pass/fail", async () => {
    const backend = memoryBackend();
    let seenOptions: { command?: string; script?: string } | undefined;
    backend.runCheck = async (options) => {
      seenOptions = options;
      return { exitCode: 0, passed: true, summary: "PASSED: npm run test (exit 0)", output: "5 passing", command: "npm run test" };
    };
    let step = 0;
    const result = await runAgentLoop({
      prompt: "run the tests",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return { content: "", toolCalls: [{ id: "1", name: "run_tests", arguments: {} }] };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.equal(seenOptions?.command, undefined);
    assert.equal(seenOptions?.script, undefined);
    assert.ok(result.messages.some((m) => m.content.includes("PASSED: npm run test (exit 0)")));
    assert.ok(result.messages.some((m) => m.content.includes("5 passing")));
  });

  it("passes script and command overrides through to the backend", async () => {
    const backend = memoryBackend();
    let seenOptions: { command?: string; script?: string } | undefined;
    backend.runCheck = async (options) => {
      seenOptions = options;
      return { exitCode: 1, passed: false, summary: "FAILED: npm run lint (exit 1)", output: "2 problems", command: "npm run lint" };
    };
    let step = 0;
    const result = await runAgentLoop({
      prompt: "lint the project",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return { content: "", toolCalls: [{ id: "1", name: "run_tests", arguments: { script: "lint" } }] };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(seenOptions?.script, "lint");
    assert.ok(result.messages.some((m) => m.content.includes("FAILED: npm run lint (exit 1)")));
  });

  it("denies run_tests in plan mode", async () => {
    const result = await runAgentLoop({
      prompt: "run tests",
      model,
      backend: memoryBackend(),
      permissionMode: "plan",
      complete: async () => ({
        content: "",
        toolCalls: [{ id: "1", name: "run_tests", arguments: {} }],
      }),
    });
    assert.equal(result.stoppedReason, "denied-tool");
  });

  it("surfaces a clear tool error when no test script and no command are available", async () => {
    const backend = memoryBackend();
    backend.runCheck = async () => {
      throw new Error('No "test" script found in package.json, and no command override was given.');
    };
    let step = 0;
    const result = await runAgentLoop({
      prompt: "run tests",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return { content: "", toolCalls: [{ id: "1", name: "run_tests", arguments: {} }] };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.ok(result.messages.some((m) => m.content.includes('Tool error: No "test" script found in package.json')));
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

  it("editFile replaces a unique old_string with new_string", async () => {
    const { backend, root, cleanup } = await makeWorkspace();
    try {
      const result = await backend.editFile("src/index.ts", "needle = 42", "needle = 7");
      assert.equal(result.replacements, 1);
      const contents = await readFile(path.join(root, "src", "index.ts"), "utf8");
      assert.match(contents, /needle = 7/);
    } finally {
      await cleanup();
    }
  });

  it("editFile throws a clear error when old_string is not found", async () => {
    const { backend, cleanup } = await makeWorkspace();
    try {
      await assert.rejects(
        () => backend.editFile("src/index.ts", "does-not-exist", "x"),
        /old_string not found/
      );
    } finally {
      await cleanup();
    }
  });

  it("editFile throws a clear error when old_string is ambiguous", async () => {
    const { backend, root, cleanup } = await makeWorkspace();
    try {
      await writeFile(path.join(root, "src", "dup.ts"), "dup dup dup\n");
      await assert.rejects(
        () => backend.editFile("src/dup.ts", "dup", "x"),
        /matches 3 locations/
      );
    } finally {
      await cleanup();
    }
  });

  it("editFile replaces all occurrences when replaceAll is set", async () => {
    const { backend, root, cleanup } = await makeWorkspace();
    try {
      await writeFile(path.join(root, "src", "dup.ts"), "dup dup dup\n");
      const result = await backend.editFile("src/dup.ts", "dup", "x", true);
      assert.equal(result.replacements, 3);
      const contents = await readFile(path.join(root, "src", "dup.ts"), "utf8");
      assert.equal(contents, "x x x\n");
    } finally {
      await cleanup();
    }
  });

  it("write_file (create) still works alongside edit_file", async () => {
    const { backend, root, cleanup } = await makeWorkspace();
    try {
      await backend.writeFile("src/created.ts", "export const created = true;\n");
      const contents = await readFile(path.join(root, "src", "created.ts"), "utf8");
      assert.equal(contents, "export const created = true;\n");
    } finally {
      await cleanup();
    }
  });

  it("readFile returns the whole file when no range is given", async () => {
    const { backend, cleanup } = await makeWorkspace();
    try {
      const contents = await backend.readFile("src/index.ts");
      assert.equal(contents, "export const needle = 42;\n");
    } finally {
      await cleanup();
    }
  });

  it("readFile supports a 1-based offset/limit line range", async () => {
    const { backend, root, cleanup } = await makeWorkspace();
    try {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
      await writeFile(path.join(root, "src", "ranged.ts"), lines);
      const slice = await backend.readFile("src/ranged.ts", { offset: 3, limit: 2 });
      assert.equal(slice, "line 3\nline 4");
    } finally {
      await cleanup();
    }
  });

  it("readFile reports when offset is past the end of the file", async () => {
    const { backend, cleanup } = await makeWorkspace();
    try {
      const result = await backend.readFile("src/index.ts", { offset: 999 });
      assert.match(result, /offset 999 is past end of file/);
    } finally {
      await cleanup();
    }
  });

  it("readFile truncates oversized results with a marker", async () => {
    const { backend, root, cleanup } = await makeWorkspace();
    try {
      const bigLines = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
      await writeFile(path.join(root, "src", "big.ts"), bigLines);
      const result = await backend.readFile("src/big.ts");
      assert.match(result, /\.\.\. truncated \d+ lines \.\.\./);
    } finally {
      await cleanup();
    }
  });

  it("bash output is capped with a truncation marker for very long output", async () => {
    const { backend, cleanup } = await makeWorkspace();
    try {
      const result = await backend.run("for i in $(seq 1 2000); do echo line$i; done");
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /\.\.\. truncated \d+ lines \.\.\./);
    } finally {
      await cleanup();
    }
  });

  it("read_file tool call passes offset/limit through the loop", async () => {
    const { backend, root, cleanup } = await makeWorkspace();
    try {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
      await writeFile(path.join(root, "src", "ranged.ts"), lines);
      let step = 0;
      const result = await runAgentLoop({
        prompt: "read a slice",
        model,
        backend,
        permissionMode: "plan",
        complete: async () => {
          step += 1;
          if (step === 1) {
            return {
              content: "",
              toolCalls: [
                { id: "1", name: "read_file", arguments: { path: "src/ranged.ts", offset: "3", limit: "2" } },
              ],
            };
          }
          return { content: "done", toolCalls: [] };
        },
      });
      assert.equal(result.stoppedReason, "complete");
      assert.ok(result.messages.some((message) => message.content === "line 3\nline 4"));
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

describe("todo_write tool", () => {
  it("creates a todo list and reflects it in the tool result and loop's todos", async () => {
    const backend = memoryBackend();
    const todos: import("./todos.ts").TodoItem[] = [];
    let step = 0;
    const result = await runAgentLoop({
      prompt: "plan the work",
      model,
      backend,
      permissionMode: "build",
      todos,
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "todo_write",
                arguments: {
                  items: JSON.stringify([
                    { id: "1", content: "Read files", status: "pending" },
                    { id: "2", content: "Write code", status: "pending" },
                  ]),
                },
              },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.equal(result.todos.length, 2);
    assert.equal(todos.length, 2, "the caller's array should be mutated in place");
    assert.ok(result.messages.some((message) => message.content.includes("Read files")));
  });

  it("updates an item's status (in_progress) on a later call", async () => {
    const backend = memoryBackend();
    const todos: import("./todos.ts").TodoItem[] = [{ id: "1", content: "Read files", status: "pending" }];
    let step = 0;
    const result = await runAgentLoop({
      prompt: "start work",
      model,
      backend,
      permissionMode: "build",
      todos,
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "todo_write",
                arguments: {
                  items: JSON.stringify([{ id: "1", content: "Read files", status: "in_progress" }]),
                },
              },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.equal(todos[0].status, "in_progress");
  });

  it("marks an item completed", async () => {
    const backend = memoryBackend();
    const todos: import("./todos.ts").TodoItem[] = [{ id: "1", content: "Read files", status: "in_progress" }];
    let step = 0;
    const result = await runAgentLoop({
      prompt: "finish work",
      model,
      backend,
      permissionMode: "build",
      todos,
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "todo_write",
                arguments: {
                  items: JSON.stringify([{ id: "1", content: "Read files", status: "completed" }]),
                },
              },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.equal(todos[0].status, "completed");
  });

  it("is allowed in plan mode", async () => {
    let step = 0;
    const result = await runAgentLoop({
      prompt: "plan only",
      model,
      backend: memoryBackend(),
      permissionMode: "plan",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "todo_write",
                arguments: { items: JSON.stringify([{ id: "1", content: "Investigate", status: "pending" }]) },
              },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.equal(result.todos.length, 1);
  });

  it("surfaces a tool error on malformed items without crashing the loop", async () => {
    let step = 0;
    const result = await runAgentLoop({
      prompt: "bad todo",
      model,
      backend: memoryBackend(),
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return { content: "", toolCalls: [{ id: "1", name: "todo_write", arguments: { items: "not json" } }] };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.ok(result.messages.some((message) => message.content.includes("Tool error:")));
  });
});

describe("delegate subagent tool", () => {
  it("is isolated from the parent's conversation and cannot spawn a nested subagent (depth limit)", async () => {
    const backend = memoryBackend();
    let callCount = 0;
    const seenMessages: ChatMessage[][] = [];
    const complete: CompletionClient["complete"] = async (input) => {
      callCount += 1;
      seenMessages.push(input.messages);
      if (callCount === 1) {
        // Parent step 1: delegate a subtask.
        return { content: "", toolCalls: [{ id: "1", name: "delegate", arguments: { task: "child task" } }] };
      }
      if (callCount === 2) {
        // Child step 1: try to spawn a grandchild — must be blocked before it ever runs.
        return { content: "", toolCalls: [{ id: "1", name: "delegate", arguments: { task: "grandchild task" } }] };
      }
      if (callCount === 3) {
        // Child step 2: finish after seeing the depth-limit denial.
        return { content: "child summary", toolCalls: [] };
      }
      // Parent step 2: finish after seeing the subagent's summary.
      return { content: "parent done", toolCalls: [] };
    };

    const result = await runAgentLoop({
      prompt: "top-level task",
      model,
      backend,
      complete,
      permissionMode: "build",
    });

    assert.equal(result.stoppedReason, "complete");
    // Only 4 completions total: parent x2, child x2 — no grandchild loop was ever started.
    assert.equal(callCount, 4);

    // Isolation: the child's own message list has no trace of the parent's prompt/history.
    const childMessages = seenMessages[1];
    assert.ok(!childMessages.some((m) => m.content.includes("top-level task")));
    assert.ok(childMessages.some((m) => m.role === "user" && m.content === "child task"));

    // The child sees a clear depth-limit error (not a hang or a real nested spawn) as its tool result.
    const childStep2Messages = seenMessages[2];
    assert.ok(childStep2Messages.some((m) => m.role === "tool" && m.content.includes("depth limit")));

    // The parent gets a summary + files-touched list, not the child's raw transcript.
    assert.ok(result.messages.some((m) => m.content.includes("Subagent done")));
    assert.ok(result.messages.some((m) => m.content.includes("child summary")));
    assert.ok(result.messages.some((m) => m.content.includes("no files touched")));
  });

  it("forces a build-mode delegate request onto the parent's stricter plan mode", async () => {
    const backend = memoryBackend();
    let callCount = 0;
    const complete: CompletionClient["complete"] = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [{ id: "1", name: "delegate", arguments: { task: "try to write", mode: "build" } }],
        };
      }
      if (callCount === 2) {
        // Child step 1: attempts a write, which should be denied because the parent is plan-mode.
        return {
          content: "",
          toolCalls: [{ id: "1", name: "write_file", arguments: { path: "x.txt", contents: "nope" } }],
        };
      }
      return { content: "parent done", toolCalls: [] };
    };

    const result = await runAgentLoop({
      prompt: "parent task",
      model,
      backend,
      complete,
      permissionMode: "plan",
    });

    assert.equal(result.stoppedReason, "complete");
    assert.equal(callCount, 3);
    assert.equal(backend.files.has("x.txt"), false);
    assert.ok(result.messages.some((m) => m.content.includes("plan mode") && m.content.includes("denied-tool")));
    assert.ok(result.messages.some((m) => m.content.includes("no files touched")));
  });

  it("hard-caps a runaway subagent at its max step count", async () => {
    const backend = memoryBackend();
    let callCount = 0;
    const complete: CompletionClient["complete"] = async (input) => {
      callCount += 1;
      const isChild = input.messages.some((m) => m.role === "user" && m.content === "loop forever");
      if (!isChild) {
        if (callCount === 1) {
          return { content: "", toolCalls: [{ id: "1", name: "delegate", arguments: { task: "loop forever" } }] };
        }
        return { content: "parent done", toolCalls: [] };
      }
      // The child never stops on its own — it should still be forced to stop at SUBAGENT_MAX_STEPS.
      return {
        content: "",
        toolCalls: [
          {
            id: "1",
            name: "todo_write",
            arguments: { items: JSON.stringify([{ id: "1", content: "keep going", status: "pending" }]) },
          },
        ],
      };
    };

    const result = await runAgentLoop({
      prompt: "parent",
      model,
      backend,
      complete,
      permissionMode: "build",
    });

    assert.equal(result.stoppedReason, "complete");
    assert.ok(result.messages.some((m) => m.content.includes("max-steps")));
  });

  it("abandons a hung subagent after the timeout instead of blocking the parent forever", async () => {
    const backend = memoryBackend();
    let callCount = 0;
    const complete: CompletionClient["complete"] = async (input) => {
      callCount += 1;
      const isChild = input.messages.some((m) => m.role === "user" && m.content === "hang forever");
      if (isChild) {
        // Never resolves — simulates a stuck model/tool call inside the subagent.
        return await new Promise<never>(() => {});
      }
      if (callCount === 1) {
        return { content: "", toolCalls: [{ id: "1", name: "delegate", arguments: { task: "hang forever" } }] };
      }
      return { content: "parent done", toolCalls: [] };
    };

    const result = await runAgentLoop({
      prompt: "parent",
      model,
      backend,
      complete,
      permissionMode: "build",
      subagentTimeoutMs: 25,
    });

    assert.equal(result.stoppedReason, "complete");
    assert.ok(result.messages.some((m) => m.content.includes("timed out")));
  });

  it("reports a clear tool error instead of crashing when task is empty", async () => {
    const backend = memoryBackend();
    let step = 0;
    const result = await runAgentLoop({
      prompt: "parent",
      model,
      backend,
      permissionMode: "build",
      complete: async () => {
        step += 1;
        if (step === 1) {
          return { content: "", toolCalls: [{ id: "1", name: "delegate", arguments: { task: "" } }] };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(result.stoppedReason, "complete");
    assert.ok(result.messages.some((m) => m.content.includes("Tool error: delegate requires a non-empty")));
  });

  it("is allowed in both plan and build permission modes", () => {
    assert.equal(isToolAllowed("plan", "delegate"), true);
    assert.equal(isToolAllowed("build", "delegate"), true);
  });

  it("requires approval like an edit tool in ask mode", () => {
    assert.equal(needsApproval("ask", "delegate"), true);
    assert.equal(needsApproval("auto", "delegate"), false);
    assert.equal(needsApproval("manual", "delegate"), true);
  });
});

function fakeMcp(): McpToolProvider & { calls: Array<{ name: string; args: Record<string, string> }> } {
  const calls: Array<{ name: string; args: Record<string, string> }> = [];
  return {
    calls,
    async listTools() {
      return [
        { name: "mcp__notes__read_note", description: "[mcp:notes] read-only lookup" },
        { name: "mcp__notes__write_note", description: "[mcp:notes] create or overwrite a note" },
      ];
    },
    classify(name) {
      if (name === "mcp__notes__read_note") return "read";
      if (name === "mcp__notes__write_note") return "write";
      return "unknown";
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return `called ${name}`;
    },
    async describeStatus() {
      return [];
    },
    async close() {
      return;
    },
  };
}

describe("MCP tools in the agent loop", () => {
  it("appends namespaced MCP tools to the schema sent to the model and routes calls to the provider", async () => {
    const mcp = fakeMcp();
    let sawTools: { name: string }[] = [];
    let step = 0;
    const result = await runAgentLoop({
      prompt: "look something up",
      model,
      backend: memoryBackend(),
      permissionMode: "build",
      mcp,
      complete: async ({ tools }) => {
        sawTools = tools;
        step += 1;
        if (step === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "mcp__notes__read_note", arguments: { id: "1" } }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.ok(sawTools.some((tool) => tool.name === "mcp__notes__read_note"));
    assert.ok(sawTools.some((tool) => tool.name === "mcp__notes__write_note"));
    assert.equal(result.stoppedReason, "complete");
    assert.deepEqual(mcp.calls, [{ name: "mcp__notes__read_note", args: { id: "1" } }]);
    assert.ok(result.messages.some((message) => message.content === "called mcp__notes__read_note"));
  });

  it("plan mode allows a read-classified MCP tool but denies a write-classified one", async () => {
    let readStep = 0;
    const readAllowed = await runAgentLoop({
      prompt: "read a note",
      model,
      backend: memoryBackend(),
      permissionMode: "plan",
      mcp: fakeMcp(),
      complete: async () => {
        readStep += 1;
        if (readStep === 1) {
          return { content: "", toolCalls: [{ id: "1", name: "mcp__notes__read_note", arguments: {} }] };
        }
        return { content: "done", toolCalls: [] };
      },
    });
    assert.equal(readAllowed.stoppedReason, "complete");

    const writeDenied = await runAgentLoop({
      prompt: "write a note",
      model,
      backend: memoryBackend(),
      permissionMode: "plan",
      mcp: fakeMcp(),
      complete: async () => ({
        content: "",
        toolCalls: [{ id: "1", name: "mcp__notes__write_note", arguments: {} }],
      }),
    });
    assert.equal(writeDenied.stoppedReason, "denied-tool");
  });

  it("denies an MCP tool call when no mcp provider is configured on the loop", async () => {
    const result = await runAgentLoop({
      prompt: "call an mcp tool with no provider wired up",
      model,
      backend: memoryBackend(),
      permissionMode: "build",
      complete: async () => ({
        content: "",
        toolCalls: [{ id: "1", name: "mcp__ghost__whatever", arguments: {} }],
      }),
    });
    assert.equal(result.stoppedReason, "denied-tool");
  });

  it("adds no tools and adds no overhead when mcp is omitted (disabled by default)", async () => {
    let sawTools: { name: string }[] = [];
    await runAgentLoop({
      prompt: "plain turn",
      model,
      backend: memoryBackend(),
      permissionMode: "build",
      complete: async ({ tools }) => {
        sawTools = tools;
        return { content: "done", toolCalls: [] };
      },
    });
    assert.ok(!sawTools.some((tool) => tool.name.startsWith("mcp__")));
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
