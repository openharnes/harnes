import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { scoreOutcomeChecks } from "./outcome.ts";

describe("scoreOutcomeChecks", () => {
  it("passes file_contains / final_contains / file_exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harnes-outcome-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(path.join(root, "src", "a.txt"), "hello world\n");
      const results = await scoreOutcomeChecks(
        [
          { type: "file_exists", path: "src/a.txt" },
          { type: "file_contains", path: "src/a.txt", text: "hello" },
          { type: "file_not_exists", path: "missing.txt" },
          { type: "final_contains", text: "done" },
          { type: "final_matches", pattern: "d[oO]ne" },
        ],
        { workspaceRoot: root, finalContent: "All done here." }
      );
      assert.ok(results.every((r) => r.passed));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when file content is wrong", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harnes-outcome-"));
    try {
      await writeFile(path.join(root, "x.txt"), "aaa");
      const results = await scoreOutcomeChecks(
        [{ type: "file_contains", path: "x.txt", text: "bbb" }],
        { workspaceRoot: root, finalContent: "" }
      );
      assert.equal(results[0]?.passed, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
