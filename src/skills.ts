/**
 * On-demand markdown "skills": short instruction files the agent can pull
 * into context by name instead of every prompt paying for them up front.
 * Looked up in the workspace first, then the user's config directory:
 *
 *   .harnes/skills/<name>.md              (workspace, shadows user skills)
 *   ~/.config/harnes/skills/<name>.md      (user-level, shared across projects)
 *
 * See docs/skills.md for the on-disk layout.
 */
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";

export interface SkillMeta {
  name: string;
  path: string;
}

/** Cap on a skill body's length before it's truncated on load. */
const SKILL_BODY_CAP = 8_000;

function homedir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? ".";
}

/** Directories searched for markdown skills, workspace-local first. */
export function skillDirs(cwd: string): string[] {
  return [path.join(cwd, ".harnes", "skills"), path.join(homedir(), ".config", "harnes", "skills")];
}

/**
 * Lists available skills across the workspace + user skill dirs.
 * A workspace skill shadows a user-level skill with the same name.
 */
export async function listSkills(cwd: string): Promise<SkillMeta[]> {
  const seen = new Map<string, SkillMeta>();
  for (const dir of skillDirs(cwd)) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".md")) continue;
      const name = entry.slice(0, -3);
      if (!seen.has(name)) {
        seen.set(name, { name, path: path.join(dir, entry) });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Renders a skill list for the `skill` tool's list mode and a `/skills` slash command. */
export function formatSkillList(skills: SkillMeta[]): string {
  if (skills.length === 0) return "(no skills found)";
  return skills.map((s) => `- ${s.name}`).join("\n");
}

/**
 * Loads a skill's markdown body by name (workspace skill wins over a
 * same-named user skill). Truncates an oversized body with a marker so one
 * large skill file can't blow the context window.
 */
export async function loadSkill(name: string, cwd: string): Promise<string> {
  const safeName = name.trim();
  if (!safeName || safeName.includes("/") || safeName.includes("\\") || safeName.includes("..")) {
    throw new Error(`Invalid skill name "${name}".`);
  }
  const listed = await listSkills(cwd);
  const hit = listed.find((s) => s.name === safeName || s.name.toLowerCase() === safeName.toLowerCase());
  if (hit) {
    const raw = await readFile(hit.path, "utf8");
    if (raw.length > SKILL_BODY_CAP) {
      return `${raw.slice(0, SKILL_BODY_CAP)}\n... truncated ${raw.length - SKILL_BODY_CAP} characters ...`;
    }
    return raw;
  }
  throw new Error(`Skill "${safeName}" not found in ${skillDirs(cwd).join(" or ")}.`);
}
