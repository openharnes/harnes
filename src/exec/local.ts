import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CheckResult, CheckRunOptions, CommandResult, ExecutionBackend, ReadFileOptions } from "./types.ts";
import { formatTruncatedList, truncateOutput } from "./output.ts";

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set(["node_modules", ".git", ".next"]);
/** Default cap for any single tool result re-entering the model context. */
const MAX_OUTPUT_CHARS = 20_000;
/** Default cap on lines returned by an unranged read_file call. */
const MAX_READ_LINES = 2_000;
/** Default cap on lines kept from bash stdout/stderr (split head/tail). */
const MAX_BASH_LINES = 500;
/** Default cap on entries returned by glob / list_dir. */
const MAX_LIST_ENTRIES = 500;

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

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

/** Caps bash stdout/stderr with a head+tail line cap plus a byte cap. */
function capBashOutput(text: string): string {
  return truncateOutput(text, {
    maxChars: MAX_OUTPUT_CHARS,
    maxLines: MAX_BASH_LINES,
    headLines: Math.ceil(MAX_BASH_LINES / 2),
    tailLines: Math.floor(MAX_BASH_LINES / 2),
  });
}

async function walk(root: string, dir: string, onFile: (relativePath: string) => void): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Surface in-root symlinks as files; do not follow (avoids cycles / escapes).
      onFile(path.relative(root, absolute).split(path.sep).join("/"));
      continue;
    }
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
    let runCwd = this.root;
    if (cwd !== this.root) {
      // Sandbox: never allow a cwd outside the workspace root.
      const rel = path.isAbsolute(cwd) ? path.relative(this.root, cwd) : cwd;
      runCwd = this.resolveWithinRoot(rel === "" ? "." : rel);
    }
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], {
        cwd: runCwd,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
        killSignal: "SIGTERM",
      });
      return { exitCode: 0, stdout: capBashOutput(stdout), stderr: capBashOutput(stderr) };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string };
      if (failed.killed || failed.signal === "SIGTERM") {
        return {
          exitCode: 124,
          stdout: capBashOutput(failed.stdout ?? ""),
          stderr: capBashOutput((failed.stderr ?? "") + "\n(command timed out after 120s)"),
        };
      }
      return {
        exitCode: typeof failed.code === "number" ? failed.code : 1,
        stdout: capBashOutput(failed.stdout ?? ""),
        stderr: capBashOutput(failed.stderr ?? (error instanceof Error ? error.message : String(error))),
      };
    }
  }

  /**
   * Reads a file. Without `options`, returns up to `MAX_READ_LINES` lines /
   * `MAX_OUTPUT_CHARS` characters with a truncation marker if the file is
   * larger. With `options.offset` / `options.limit`, returns that 1-based
   * line range (still subject to the character cap).
   */
  async readFile(filePath: string, options?: ReadFileOptions): Promise<string> {
    const contents = await readFile(this.resolveWithinRoot(filePath), "utf8");

    if (options?.offset === undefined && options?.limit === undefined) {
      return truncateOutput(contents, { maxChars: MAX_OUTPUT_CHARS, maxLines: MAX_READ_LINES });
    }

    const lines = contents.split("\n");
    const offset = Math.max(1, options.offset ?? 1);
    const startIndex = offset - 1;
    if (startIndex >= lines.length) {
      return `(offset ${offset} is past end of file; file has ${lines.length} lines)`;
    }
    const endIndex = options.limit !== undefined ? Math.min(lines.length, startIndex + options.limit) : lines.length;
    const ranged = lines.slice(startIndex, endIndex).join("\n");
    return truncateOutput(ranged, { maxChars: MAX_OUTPUT_CHARS });
  }

  async writeFile(filePath: string, contents: string): Promise<void> {
    const resolved = this.resolveWithinRoot(filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, contents, "utf8");
  }

  async editFile(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false
  ): Promise<{ replacements: number }> {
    if (oldString === "") {
      throw new Error("old_string must not be empty. Use write_file to create a new file.");
    }
    const resolved = this.resolveWithinRoot(filePath);
    let contents: string;
    try {
      contents = await readFile(resolved, "utf8");
    } catch (error) {
      const notFound = (error as NodeJS.ErrnoException)?.code === "ENOENT";
      throw new Error(
        notFound
          ? `File not found: ${filePath}. Use write_file to create a new file.`
          : `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const occurrences = countOccurrences(contents, oldString);
    if (occurrences === 0) {
      throw new Error(`old_string not found in ${filePath}. No edit made; the text must match exactly.`);
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_string matches ${occurrences} locations in ${filePath}. Provide more surrounding context to make it unique, or set replace_all to edit them all.`
      );
    }

    const updated = replaceAll
      ? contents.split(oldString).join(newString)
      : contents.replace(oldString, newString);
    await writeFile(resolved, updated, "utf8");
    return { replacements: occurrences };
  }

  async glob(pattern: string): Promise<string[]> {
    const matcher = globToRegExp(pattern);
    const matches: string[] = [];
    await walk(this.root, this.root, (relativePath) => {
      if (matcher.test(relativePath)) matches.push(relativePath);
    });
    matches.sort();
    const formatted = formatTruncatedList(matches, MAX_LIST_ENTRIES);
    return formatted ? formatted.split("\n") : [];
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
    let isFileTarget = false;
    try {
      isFileTarget = statSync(searchRoot).isFile();
    } catch {
      isFileTarget = false;
    }
    if (isFileTarget) {
      files.push(path.relative(this.root, searchRoot).split(path.sep).join("/") || path.basename(searchRoot));
    } else {
      await walk(this.root, searchRoot, (relativePath) => {
        if (!fileMatcher || fileMatcher.test(relativePath) || fileMatcher.test(path.basename(relativePath))) {
          files.push(relativePath);
        }
      });
      files.sort();
    }

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
    const joined = lines.join("\n");
    return truncated
      ? truncateOutput(`${joined}\n`, { maxChars: MAX_OUTPUT_CHARS })
      : joined;
  }

  async listDir(dirPath?: string): Promise<string[]> {
    const resolved = this.resolveWithinRoot(dirPath ?? ".");
    let entries;
    try {
      entries = await readdir(resolved, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new Error(`Directory not found: ${dirPath ?? "."}`);
      if (code === "ENOTDIR") throw new Error(`Not a directory: ${dirPath ?? "."}`);
      throw error;
    }
    const names = entries
      .filter((entry) => !(entry.isDirectory() && SKIP_DIRS.has(entry.name)))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    const formatted = formatTruncatedList(names, MAX_LIST_ENTRIES);
    return formatted ? formatted.split("\n") : [];
  }

  async gitStatus(): Promise<string> {
    const { stdout } = await this.runGit(["status", "--porcelain=v1", "-b"]);
    return capBashOutput(stdout.trim() === "" ? "(clean working tree)" : stdout);
  }

  async gitDiff(filePath?: string): Promise<string> {
    // Include both unstaged and staged changes (plain `git diff` hides the index).
    const args = ["diff", "HEAD"];
    if (filePath) {
      const rel = this.resolveWithinRoot(filePath);
      args.push("--", path.relative(this.root, rel) || ".");
    }
    const { stdout } = await this.runGit(args);
    return capBashOutput(stdout.trim() === "" ? "(no changes)" : stdout);
  }

  async gitLog(maxCount = 20): Promise<string> {
    const count = Math.max(1, Math.min(maxCount, 200));
    const { stdout } = await this.runGit(["log", "-n", String(count), "--pretty=format:%h %ad %s", "--date=short"]);
    return capBashOutput(stdout.trim() === "" ? "(no commits)" : stdout);
  }

  async gitCommit(message: string, options?: { stageAll?: boolean }): Promise<{ commit: string; summary: string }> {
    if (!message || message.trim() === "") {
      throw new Error("Commit message must not be empty.");
    }
    if (options?.stageAll !== false) {
      await this.runGit(["add", "-A"]);
    }
    const { stdout: staged } = await this.runGit(["diff", "--cached", "--name-only"]);
    if (staged.trim() === "") {
      throw new Error("Nothing staged to commit. Stage changes first (or omit stage_all=false) and check git_status.");
    }
    // Never --no-verify, never --amend, never a force-push flag: a plain commit only.
    const { stdout: commitOut } = await this.runGit(["commit", "-m", message]);
    const { stdout: hashOut } = await this.runGit(["rev-parse", "--short", "HEAD"]);
    return { commit: hashOut.trim(), summary: capBashOutput(commitOut.trim()) };
  }

  /**
   * Runs a test/lint/typecheck/build check and reports pass/fail. With no
   * `command`, discovers a matching `package.json` script (default "test")
   * under the workspace root and runs it via `npm run <script>`.
   */
  async runCheck(options?: CheckRunOptions): Promise<CheckResult> {
    let command: string;
    let label: string;
    if (options?.command && options.command.trim() !== "") {
      command = options.command;
      label = command;
    } else {
      const script = options?.script && options.script.trim() !== "" ? options.script : "test";
      const found = await this.findPackageScript(script);
      if (!found) {
        throw new Error(
          `No "${script}" script found in package.json, and no command override was given. Pass "command" to run something else directly.`
        );
      }
      command = `npm run ${script} --if-present`;
      label = `npm run ${script} (${found})`;
    }

    const result = await this.run(command);
    const passed = result.exitCode === 0;
    const output = capBashOutput(`${result.stdout}${result.stderr}`);
    const summary = `${passed ? "PASSED" : "FAILED"}: ${label} (exit ${result.exitCode})`;
    return { exitCode: result.exitCode, passed, summary, output, command };
  }

  /** Reads package.json at the workspace root and returns the named script's command, or undefined if absent. */
  private async findPackageScript(script: string): Promise<string | undefined> {
    let raw: string;
    try {
      raw = await readFile(path.join(this.root, "package.json"), "utf8");
    } catch {
      return undefined;
    }
    try {
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
      return pkg.scripts?.[script];
    } catch {
      return undefined;
    }
  }

  /** Runs a git subcommand rooted at this backend's workspace root. Throws with stderr (or the error message) on failure. */
  private async runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: this.root,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout, stderr };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; message?: string };
      const message = failed.stderr?.trim() || failed.message || String(error);
      throw new Error(message);
    }
  }

  async close(): Promise<void> {
    return;
  }

  /** Resolves a path and ensures it stays within the backend root (rejects symlink escapes). */
  private resolveWithinRoot(filePath: string): string {
    const resolved = path.resolve(this.root, filePath);
    const rootResolved = path.resolve(this.root);
    const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
    if (resolved !== rootResolved && !resolved.startsWith(rootWithSep)) {
      throw new Error(`Path escapes workspace root: ${filePath}`);
    }
    // If the path (or a symlink parent) already exists, reject escapes via realpath.
    try {
      const realRoot = existsSync(rootResolved) ? realpathSync(rootResolved) : rootResolved;
      const probe = existsSync(resolved)
        ? realpathSync(resolved)
        : (() => {
            let dir = path.dirname(resolved);
            while (dir !== path.dirname(dir)) {
              if (existsSync(dir)) return path.join(realpathSync(dir), path.relative(dir, resolved));
              dir = path.dirname(dir);
            }
            return resolved;
          })();
      const realRootSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
      if (probe !== realRoot && !probe.startsWith(realRootSep)) {
        throw new Error(`Path escapes workspace root: ${filePath}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Path escapes")) throw error;
      throw new Error(
        `Path could not be verified inside workspace root: ${filePath} (${error instanceof Error ? error.message : String(error)})`
      );
    }
    return resolved;
  }
}
