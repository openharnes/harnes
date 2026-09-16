import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandResult, ExecutionBackend } from "./types.ts";

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set(["node_modules", ".git", ".next"]);
const MAX_OUTPUT_CHARS = 20_000;

/** Converts a glob pattern (supports `**`, `*`, `?`) into an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`);
}

async function walk(root: string, dir: string, onFile: (relativePath: string) => void): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, onFile);
    } else if (entry.isFile()) {
      onFile(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
}

export class LocalBackend implements ExecutionBackend {
  readonly mode = "local" as const;

  constructor(private readonly root: string) {}

  async run(command: string, cwd = this.root): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], {
        cwd,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number };
      return {
        exitCode: typeof failed.code === "number" ? failed.code : 1,
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  async readFile(filePath: string): Promise<string> {
    return readFile(this.resolveWithinRoot(filePath), "utf8");
  }

  async writeFile(filePath: string, contents: string): Promise<void> {
    const resolved = this.resolveWithinRoot(filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, contents, "utf8");
  }

  async glob(pattern: string): Promise<string[]> {
    const matcher = globToRegExp(pattern);
    const matches: string[] = [];
    await walk(this.root, this.root, (relativePath) => {
      if (matcher.test(relativePath)) matches.push(relativePath);
    });
    matches.sort();
    return matches;
  }

  async grep(pattern: string, searchPath?: string, glob?: string): Promise<string> {
    const searchRoot = this.resolveWithinRoot(searchPath ?? ".");
    const fileMatcher = glob ? globToRegExp(glob) : undefined;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      return `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`;
    }

    const files: string[] = [];
    await walk(this.root, searchRoot, (relativePath) => {
      if (!fileMatcher || fileMatcher.test(relativePath) || fileMatcher.test(path.basename(relativePath))) {
        files.push(relativePath);
      }
    });
    files.sort();

    const lines: string[] = [];
    let size = 0;
    let truncated = false;
    outer: for (const relativePath of files) {
      let contents: string;
      try {
        contents = await readFile(path.join(this.root, relativePath), "utf8");
      } catch {
        continue;
      }
      const fileLines = contents.split("\n");
      for (let i = 0; i < fileLines.length; i += 1) {
        if (!regex.test(fileLines[i])) continue;
        const entry = `${relativePath}:${i + 1}: ${fileLines[i]}`;
        if (size + entry.length + 1 > MAX_OUTPUT_CHARS) {
          truncated = true;
          break outer;
        }
        lines.push(entry);
        size += entry.length + 1;
      }
    }
    if (lines.length === 0) return "No matches.";
    return truncated ? `${lines.join("\n")}\n... (truncated)` : lines.join("\n");
  }

  async listDir(dirPath?: string): Promise<string[]> {
    const resolved = this.resolveWithinRoot(dirPath ?? ".");
    const entries = await readdir(resolved, { withFileTypes: true });
    return entries
      .filter((entry) => !(entry.isDirectory() && SKIP_DIRS.has(entry.name)))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
  }

  async close(): Promise<void> {
    return;
  }

  /** Resolves a path and ensures it stays within the backend root. */
  private resolveWithinRoot(filePath: string): string {
    const resolved = path.resolve(this.root, filePath);
    const rootResolved = path.resolve(this.root);
    const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
    if (resolved !== rootResolved && !resolved.startsWith(rootWithSep)) {
      throw new Error(`Path escapes workspace root: ${filePath}`);
    }
    return resolved;
  }
}
