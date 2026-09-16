import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalBackend } from "./local.ts";

const execFileAsync = promisify(execFile);

async function makeGitRepo(): Promise<{ backend: LocalBackend; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "harnes-git-test-"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Harnes Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "hello\n");
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", "initial commit"], { cwd: root });
  return { backend: new LocalBackend(root), root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("LocalBackend git tools (temp git repo)", () => {
  it("gitStatus reports a clean tree after the initial commit", async () => {
    const { backend, cleanup } = await makeGitRepo();
    try {
      const status = await backend.gitStatus();
      assert.match(status, /## main|clean working tree/);
    } finally {
      await cleanup();
    }
  });

  it("gitStatus reports untracked and modified files", async () => {
    const { backend, root, cleanup } = await makeGitRepo();
    try {
      await writeFile(path.join(root, "README.md"), "hello again\n");
      await writeFile(path.join(root, "new.txt"), "new file\n");
      const status = await backend.gitStatus();
      assert.match(status, /README\.md/);
      assert.match(status, /new\.txt/);
    } finally {
      await cleanup();
    }
  });

  it("gitDiff shows an empty diff on a clean tree", async () => {
    const { backend, cleanup } = await makeGitRepo();
    try {
      const diff = await backend.gitDiff();
      assert.equal(diff, "(no changes)");
    } finally {
      await cleanup();
    }
  });

  it("gitDiff shows changes to a modified file, and can be scoped to a path", async () => {
    const { backend, root, cleanup } = await makeGitRepo();
    try {
      await writeFile(path.join(root, "README.md"), "hello again\n");
      const diff = await backend.gitDiff();
      assert.match(diff, /README\.md/);
      assert.match(diff, /hello again/);

      const scoped = await backend.gitDiff("README.md");
      assert.match(scoped, /README\.md/);
    } finally {
      await cleanup();
    }
  });

  it("gitLog lists commit history, most recent first, capped by max_count", async () => {
    const { backend, root, cleanup } = await makeGitRepo();
    try {
      await writeFile(path.join(root, "second.txt"), "second\n");
      await execFileAsync("git", ["add", "-A"], { cwd: root });
      await execFileAsync("git", ["commit", "-q", "-m", "second commit"], { cwd: root });

      const log = await backend.gitLog();
      const lines = log.split("\n").filter((line) => line.trim() !== "");
      assert.equal(lines.length, 2);
      assert.match(lines[0], /second commit/);
      assert.match(lines[1], /initial commit/);

      const capped = await backend.gitLog(1);
      assert.equal(capped.split("\n").filter((line) => line.trim() !== "").length, 1);
    } finally {
      await cleanup();
    }
  });

  it("gitCommit stages all changes by default and creates a real commit", async () => {
    const { backend, root, cleanup } = await makeGitRepo();
    try {
      await writeFile(path.join(root, "feature.txt"), "a new feature\n");
      const result = await backend.gitCommit("Add feature.txt");
      assert.match(result.commit, /^[0-9a-f]{7,}$/);

      const { stdout: log } = await execFileAsync("git", ["log", "--oneline", "-n", "1"], { cwd: root });
      assert.match(log, /Add feature\.txt/);

      const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: root });
      assert.equal(status.trim(), "");
    } finally {
      await cleanup();
    }
  });

  it("gitCommit with stageAll=false only commits what is already staged", async () => {
    const { backend, root, cleanup } = await makeGitRepo();
    try {
      await writeFile(path.join(root, "staged.txt"), "staged\n");
      await writeFile(path.join(root, "unstaged.txt"), "unstaged\n");
      await execFileAsync("git", ["add", "staged.txt"], { cwd: root });

      await backend.gitCommit("Add staged.txt only", { stageAll: false });

      const { stdout: log } = await execFileAsync("git", ["log", "--name-only", "-n", "1", "--pretty=format:"], {
        cwd: root,
      });
      assert.match(log, /staged\.txt/);
      assert.ok(!log.includes("unstaged.txt"));

      const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: root });
      assert.match(status, /unstaged\.txt/);
    } finally {
      await cleanup();
    }
  });

  it("gitCommit throws a clear error for an empty message", async () => {
    const { backend, root, cleanup } = await makeGitRepo();
    try {
      await writeFile(path.join(root, "x.txt"), "x\n");
      await assert.rejects(() => backend.gitCommit(""), /Commit message must not be empty/);
      await assert.rejects(() => backend.gitCommit("   "), /Commit message must not be empty/);
    } finally {
      await cleanup();
    }
  });

  it("gitCommit throws a clear error when there is nothing to commit", async () => {
    const { backend, cleanup } = await makeGitRepo();
    try {
      await assert.rejects(() => backend.gitCommit("nothing changed"), /Nothing staged to commit/);
    } finally {
      await cleanup();
    }
  });

  it("gitStatus/gitDiff/gitLog fail clearly outside a git repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harnes-not-git-"));
    const backend = new LocalBackend(root);
    try {
      await assert.rejects(() => backend.gitStatus());
      await assert.rejects(() => backend.gitCommit("wip"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
