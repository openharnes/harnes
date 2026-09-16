import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatSkillList, listSkills, loadSkill, skillDirs } from "./skills.ts";

async function withWorkspace(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harnes-skills-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("loadSkill", () => {
  it("loads a fixture skill's markdown body from .harnes/skills", async () => {
    await withWorkspace(async (cwd) => {
      const dir = path.join(cwd, ".harnes", "skills");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "review.md"), "# Review\nCheck for bugs first.\n", "utf8");

      const body = await loadSkill("review", cwd);
      assert.equal(body, "# Review\nCheck for bugs first.\n");
    });
  });

  it("throws a clear error when the skill is missing", async () => {
    await withWorkspace(async (cwd) => {
      await assert.rejects(() => loadSkill("nope", cwd), /not found/);
    });
  });

  it("rejects path-traversal-looking names", async () => {
    await withWorkspace(async (cwd) => {
      await assert.rejects(() => loadSkill("../etc/passwd", cwd), /Invalid skill name/);
      await assert.rejects(() => loadSkill("a/b", cwd), /Invalid skill name/);
    });
  });

  it("truncates an oversized skill body with a marker", async () => {
    await withWorkspace(async (cwd) => {
      const dir = path.join(cwd, ".harnes", "skills");
      await mkdir(dir, { recursive: true });
      const big = "x".repeat(9_000);
      await writeFile(path.join(dir, "big.md"), big, "utf8");

      const body = await loadSkill("big", cwd);
      assert.ok(body.length < big.length);
      assert.match(body, /truncated \d+ characters/);
    });
  });
});

describe("listSkills", () => {
  it("lists markdown skills and lets a workspace skill shadow a user-level one", async () => {
    await withWorkspace(async (cwd) => {
      const workspaceDir = path.join(cwd, ".harnes", "skills");
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(path.join(workspaceDir, "shared.md"), "workspace version", "utf8");
      await writeFile(path.join(workspaceDir, "only-workspace.md"), "hi", "utf8");

      const [, userDir] = skillDirs(cwd);
      await mkdir(userDir, { recursive: true });
      await writeFile(path.join(userDir, "shared.md"), "user version", "utf8");
      await writeFile(path.join(userDir, "only-user.md"), "hi", "utf8");

      try {
        const skills = await listSkills(cwd);
        const names = skills.map((s) => s.name).sort();
        assert.deepEqual(names, ["only-user", "only-workspace", "shared"]);

        const shared = skills.find((s) => s.name === "shared");
        assert.ok(shared);
        assert.equal(shared?.path, path.join(workspaceDir, "shared.md"));
      } finally {
        await rm(userDir, { recursive: true, force: true });
      }
    });
  });

  it("returns an empty list when no skill dirs exist", async () => {
    await withWorkspace(async (cwd) => {
      const skills = await listSkills(cwd);
      assert.deepEqual(skills, []);
    });
  });
});

describe("formatSkillList", () => {
  it("renders a placeholder for an empty list", () => {
    assert.equal(formatSkillList([]), "(no skills found)");
  });

  it("renders one bullet per skill", () => {
    const text = formatSkillList([
      { name: "a", path: "/a.md" },
      { name: "b", path: "/b.md" },
    ]);
    assert.equal(text, "- a\n- b");
  });
});
