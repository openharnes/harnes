import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { clearHooks, registerHook, runHooks, type HookPayload } from "./hooks.ts";

describe("registerHook / runHooks (in-process)", () => {
  afterEach(() => {
    clearHooks();
  });

  it("fires a registered preToolUse handler with the call payload", async () => {
    let count = 0;
    let seen: HookPayload | undefined;
    registerHook("preToolUse", (payload) => {
      count += 1;
      seen = payload;
    });

    await runHooks("preToolUse", { event: "preToolUse", tool: "bash", arguments: { command: "echo hi" } });

    assert.equal(count, 1);
    assert.equal(seen?.tool, "bash");
  });

  it("fires a registered postToolUse handler with the result", async () => {
    let count = 0;
    registerHook("postToolUse", () => {
      count += 1;
    });

    await runHooks("postToolUse", {
      event: "postToolUse",
      tool: "bash",
      arguments: {},
      result: "exit 0",
    });

    assert.equal(count, 1);
  });

  it("only fires handlers for the matching event", async () => {
    let preCount = 0;
    let postCount = 0;
    registerHook("preToolUse", () => {
      preCount += 1;
    });
    registerHook("postToolUse", () => {
      postCount += 1;
    });

    await runHooks("preToolUse", { event: "preToolUse", tool: "bash", arguments: {} });

    assert.equal(preCount, 1);
    assert.equal(postCount, 0);
  });

  it("does not throw when a handler throws, and still runs the rest", async () => {
    let ranAfter = false;
    registerHook("preToolUse", () => {
      throw new Error("boom");
    });
    registerHook("preToolUse", () => {
      ranAfter = true;
    });

    await runHooks("preToolUse", { event: "preToolUse", tool: "bash", arguments: {} });

    assert.equal(ranAfter, true);
  });

  it("unregister removes the handler", async () => {
    let count = 0;
    const unregister = registerHook("preToolUse", () => {
      count += 1;
    });
    unregister();

    await runHooks("preToolUse", { event: "preToolUse", tool: "bash", arguments: {} });

    assert.equal(count, 0);
  });
});

describe("runHooks (config-defined shell hooks)", () => {
  it("runs a matching shell hook and passes the payload on stdin", async () => {
    const marker = `/tmp/harnes-hook-test-${process.pid}-${Date.now()}.json`;
    await runHooks(
      "postToolUse",
      { event: "postToolUse", tool: "bash", arguments: { command: "echo hi" }, result: "exit 0" },
      [{ match: "bash", command: `cat > ${marker}` }]
    );

    const { readFile, rm } = await import("node:fs/promises");
    const written = JSON.parse(await readFile(marker, "utf8")) as HookPayload;
    assert.equal(written.tool, "bash");
    await rm(marker, { force: true });
  });

  it("skips a shell hook whose match does not name this tool", async () => {
    const marker = `/tmp/harnes-hook-test-skip-${process.pid}-${Date.now()}.json`;
    await runHooks("postToolUse", { event: "postToolUse", tool: "bash", arguments: {}, result: "ok" }, [
      { match: "edit_file", command: `cat > ${marker}` },
    ]);

    const { access } = await import("node:fs/promises");
    await assert.rejects(() => access(marker));
  });

  it("does not throw when the shell hook command fails", async () => {
    await runHooks("postToolUse", { event: "postToolUse", tool: "bash", arguments: {}, result: "ok" }, [
      { command: "exit 1" },
    ]);
    // No assertion needed beyond "did not throw".
  });
});
