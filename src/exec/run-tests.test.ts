import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalBackend } from "./local.ts";

async function makeProject(scripts: Record<string, string>): Promise<{ backend: LocalBackend; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "harnes-run-tests-"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", scripts }, null, 2)
  );
  return { backend: new LocalBackend(root), root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("LocalBackend.runCheck", () => {
  it("discovers and runs the package.json 'test' script by default, reporting a pass", async () => {
    const { backend, cleanup } = await makeProject({ test: "node -e \"console.log('5 passing')\"" });
    try {
      const result = await backend.runCheck();
      assert.equal(result.exitCode, 0);
      assert.equal(result.passed, true);
      assert.match(result.summary, /^PASSED: npm run test/);
      assert.match(result.summary, /exit 0/);
      assert.match(result.output, /5 passing/);
      assert.match(result.command, /npm run test/);
    } finally {
      await cleanup();
    }
  });

  it("reports a clear failure with a non-zero exit code and FAILED summary", async () => {
    const { backend, cleanup } = await makeProject({ test: "node -e \"console.error('boom'); process.exit(1)\"" });
    try {
      const result = await backend.runCheck();
      assert.equal(result.exitCode, 1);
      assert.equal(result.passed, false);
      assert.match(result.summary, /^FAILED: npm run test/);
      assert.match(result.summary, /exit 1/);
      assert.match(result.output, /boom/);
    } finally {
      await cleanup();
    }
  });

  it("runs a non-default script when 'script' is given (lint/typecheck/build discovery)", async () => {
    const { backend, cleanup } = await makeProject({
      test: "node -e \"process.exit(1)\"",
      lint: "node -e \"console.log('no lint problems')\"",
    });
    try {
      const result = await backend.runCheck({ script: "lint" });
      assert.equal(result.passed, true);
      assert.match(result.summary, /npm run lint/);
      assert.match(result.output, /no lint problems/);
    } finally {
      await cleanup();
    }
  });

  it("throws a clear error when the requested script is missing and no command override is given", async () => {
    const { backend, cleanup } = await makeProject({ test: "node -e \"process.exit(0)\"" });
    try {
      await assert.rejects(() => backend.runCheck({ script: "typecheck" }), /No "typecheck" script found in package\.json/);
    } finally {
      await cleanup();
    }
  });

  it("throws a clear error when there is no package.json and no command override", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harnes-run-tests-nopkg-"));
    const backend = new LocalBackend(root);
    try {
      await assert.rejects(() => backend.runCheck(), /No "test" script found in package\.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("an explicit 'command' override runs directly and bypasses package.json discovery entirely", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harnes-run-tests-cmd-"));
    const backend = new LocalBackend(root);
    try {
      const result = await backend.runCheck({ command: "node -e \"console.log('custom check ok')\"" });
      assert.equal(result.passed, true);
      assert.equal(result.command, "node -e \"console.log('custom check ok')\"");
      assert.match(result.output, /custom check ok/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps very long output like bash output", async () => {
    const { backend, cleanup } = await makeProject({
      test: 'node -e "for (let i = 0; i < 4000; i++) console.log(\'line \' + i)"',
    });
    try {
      const result = await backend.runCheck();
      assert.ok(result.output.includes("truncated"));
    } finally {
      await cleanup();
    }
  });

  it("runs this repo's own 'npm run typecheck' script via runCheck (real subprocess, real repo)", async () => {
    const backend = new LocalBackend(path.resolve(import.meta.dirname, "../.."));
    const result = await backend.runCheck({ script: "typecheck" });
    assert.equal(typeof result.exitCode, "number");
    assert.equal(result.passed, result.exitCode === 0);
    assert.match(result.summary, /npm run typecheck/);
  });
});
