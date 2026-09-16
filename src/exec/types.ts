export type ExecMode = "local";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecutionBackend {
  readonly mode: ExecMode;
  run(command: string, cwd?: string): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  /** Workspace file search. Returns matching relative paths, skipping node_modules/.git/.next. */
  glob(pattern: string): Promise<string[]>;
  /** ripgrep-style content search. Returns "path:line: content" matches, capped in size. */
  grep(pattern: string, path?: string, glob?: string): Promise<string>;
  /** Directory listing. Entries are relative names; directories end with "/". */
  listDir(path?: string): Promise<string[]>;
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
  if (mode === "plan") return ["read_file", "glob", "grep", "list_dir"];
  return ["read_file", "write_file", "bash", "glob", "grep", "list_dir"];
}

export function isToolAllowed(mode: PermissionMode, tool: string): boolean {
  return toolsForMode(mode).includes(tool);
}

const EDIT_TOOLS = new Set(["write_file", "bash"]);

/** Whether this tool call should prompt the user before running. */
export function needsApproval(sessionMode: SessionMode, tool: string): boolean {
  if (sessionMode === "auto" || sessionMode === "plan") return false;
  if (sessionMode === "manual") return true;
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
