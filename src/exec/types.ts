export type ExecMode = "local";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ReadFileOptions {
  /**
   * 1-based line number to start reading from (inclusive). Defaults to 1.
   * A value < 1 is treated as 1.
   */
  offset?: number;
  /**
   * Maximum number of lines to return, starting at `offset`. When omitted,
   * reads to the end of the file (still subject to the output size cap).
   */
  limit?: number;
}

export interface CheckRunOptions {
  /**
   * Raw shell command override. When set, this runs instead of any
   * package.json script discovery — e.g. "npx tsx --test src/foo.test.ts".
   */
  command?: string;
  /**
   * Which package.json script to run when `command` is not set.
   * Defaults to "test". Common values: "test", "lint", "typecheck", "build".
   */
  script?: string;
}

export interface CheckResult {
  exitCode: number;
  /** true when exitCode === 0. */
  passed: boolean;
  /** One-line PASS/FAIL summary the model can trust without re-reading output. */
  summary: string;
  /** Combined, capped stdout+stderr. */
  output: string;
  /** The command that was actually run. */
  command: string;
}

export interface ExecutionBackend {
  readonly mode: ExecMode;
  run(command: string, cwd?: string): Promise<CommandResult>;
  /**
   * Reads a file, optionally scoped to a line range via `offset`/`limit`
   * (1-based, inclusive start). Oversized results are truncated with a
   * `... truncated N bytes/lines ...` marker rather than returned in full.
   */
  readFile(path: string, options?: ReadFileOptions): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  /**
   * Precise in-place edit: replaces `oldString` with `newString`.
   * Throws if `oldString` is not found, or is found more than once unless `replaceAll` is set.
   */
  editFile(path: string, oldString: string, newString: string, replaceAll?: boolean): Promise<{ replacements: number }>;
  /** Workspace file search. Returns matching relative paths, skipping node_modules/.git/.next. */
  glob(pattern: string): Promise<string[]>;
  /** ripgrep-style content search. Returns "path:line: content" matches, capped in size. */
  grep(pattern: string, path?: string, glob?: string): Promise<string>;
  /** Directory listing. Entries are relative names; directories end with "/". */
  listDir(path?: string): Promise<string[]>;
  /** `git status --porcelain -b`, capped like bash output. Read-only. */
  gitStatus(): Promise<string>;
  /** `git diff`, optionally scoped to a path. Capped like bash output. Read-only. */
  gitDiff(path?: string): Promise<string>;
  /** Recent commit history, most recent first. Capped to `maxCount` entries (default 20). Read-only. */
  gitLog(maxCount?: number): Promise<string>;
  /**
   * Stages changes (by default, all of them — `git add -A`) and creates a commit
   * with the given message. Never passes `--no-verify`, `--amend`, or a force
   * push flag. Throws with a clear message if there is nothing staged, the
   * message is empty, or the commit hook fails.
   */
  gitCommit(message: string, options?: { stageAll?: boolean }): Promise<{ commit: string; summary: string }>;
  /**
   * Runs the project's test/lint/typecheck/build step and reports pass/fail.
   * With no `command`, discovers a matching `package.json` script (default
   * "test") and runs it via `npm run <script>`. Throws if neither a command
   * nor a matching script is found. Output is capped like `run`.
   */
  runCheck(options?: CheckRunOptions): Promise<CheckResult>;
  close(): Promise<void>;
}

/**
 * Tool surface for the agent loop.
 * plan = read-only explore tools; build = writes + bash allowed (subject to approval).
 */
export type PermissionMode = "plan" | "build";

/**
 * Session approval mode (Shift+Tab cycles these).
 * - auto: run all allowed tools without asking
 * - manual: ask before every tool
 * - ask: ask only before edits (write_file / bash)
 * - plan: read-only tools
 */
export type SessionMode = "auto" | "manual" | "ask" | "plan";

export const SESSION_MODES: SessionMode[] = ["auto", "manual", "ask", "plan"];

export const SESSION_MODE_LABELS: Record<SessionMode, string> = {
  auto: "automatic",
  manual: "manual",
  ask: "ask on edit",
  plan: "plan",
};

export function toolsForMode(mode: PermissionMode): string[] {
  if (mode === "plan") {
    return ["read_file", "glob", "grep", "list_dir", "todo_write", "git_status", "git_diff", "git_log", "delegate", "skill"];
  }
  return [
    "read_file",
    "write_file",
    "edit_file",
    "bash",
    "glob",
    "grep",
    "list_dir",
    "todo_write",
    "git_status",
    "git_diff",
    "git_log",
    "git_commit",
    "run_tests",
    "delegate",
    "skill",
  ];
}

export function isToolAllowed(mode: PermissionMode, tool: string): boolean {
  return toolsForMode(mode).includes(tool);
}

/** Namespace prefix for tools proxied from an external MCP server, e.g. `mcp__github__search_issues`. */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * Read/write classification for an MCP tool, used for permission gating.
 * "unknown" means neither the server's `annotations` nor a name/description
 * keyword heuristic could tell — treated as mutating for safety (see
 * `mcpToolAllowed` and `needsApproval`).
 */
export type McpToolClass = "read" | "write" | "unknown";

/**
 * Whether an MCP tool call is allowed at all in this permission mode.
 * `plan` only allows tools confidently classified as read-only; `build`
 * allows everything (mutations still go through `needsApproval`).
 */
export function mcpToolAllowed(mode: PermissionMode, mcpClass: McpToolClass): boolean {
  if (mode === "plan") return mcpClass === "read";
  return true;
}

/**
 * `delegate` is here even though its default (`mode` omitted) is a read-only
 * plan-mode subagent: a `build`-mode delegate call can write, and `needsApproval`
 * only sees the tool name, not its arguments, so `ask` mode prompts for any
 * delegate call rather than trying to peek at the requested mode.
 */
const EDIT_TOOLS = new Set(["write_file", "edit_file", "bash", "git_commit", "delegate"]);

/**
 * `run_tests` is intentionally NOT in EDIT_TOOLS: it's a verify step (test/
 * lint/typecheck/build), not a mutation, so `ask` mode auto-runs it like the
 * read-only git tools rather than prompting. Its optional `command` override
 * can technically run arbitrary shell (same power as `bash`), so it is still
 * denied in `plan` mode (see toolsForMode) — only `ask`/`manual`/`auto` in
 * `build` mode can reach it, and `manual` still prompts for every tool.
 */

/**
 * Whether this tool call should prompt the user before running. `mcpClass`
 * (only meaningful for `mcp__`-prefixed tools) lets `ask` mode auto-run a
 * confidently read-only MCP tool while still prompting for a write or
 * unknown one — pass it for any `mcp__` tool; other tools ignore it.
 */
export function needsApproval(sessionMode: SessionMode, tool: string, mcpClass?: McpToolClass): boolean {
  if (sessionMode === "auto" || sessionMode === "plan") return false;
  if (sessionMode === "manual") return true;
  if (tool.startsWith(MCP_TOOL_PREFIX)) return mcpClass !== "read";
  return EDIT_TOOLS.has(tool);
}

export function permissionForSessionMode(mode: SessionMode): PermissionMode {
  return mode === "plan" ? "plan" : "build";
}

export function cycleSessionMode(current: SessionMode): SessionMode {
  const i = SESSION_MODES.indexOf(current);
  return SESSION_MODES[(i < 0 ? 0 : i + 1) % SESSION_MODES.length];
}

/** Normalize config / slash args. Legacy `build` → `auto`. */
export function normalizeSessionMode(value: string | undefined): SessionMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "plan") return "plan";
  if (v === "manual") return "manual";
  if (v === "ask" || v === "ask-on-edit" || v === "ask_on_edit") return "ask";
  if (v === "auto" || v === "automatic") return "auto";
  if (v === "build") return "auto";
  return "ask";
}
