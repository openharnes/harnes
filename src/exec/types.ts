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

export type PermissionMode = "plan" | "build";

/** auto = route tools + model per prompt; plan/build pin tool surface. */
export type SessionMode = "auto" | "plan" | "build";

export function toolsForMode(mode: PermissionMode): string[] {
  if (mode === "plan") return ["read_file", "glob", "grep", "list_dir"];
  return ["read_file", "write_file", "bash", "glob", "grep", "list_dir"];
}

export function isToolAllowed(mode: PermissionMode, tool: string): boolean {
  return toolsForMode(mode).includes(tool);
}
