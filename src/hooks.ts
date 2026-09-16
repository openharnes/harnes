/**
 * Thin hook points around tool execution: `preToolUse` fires just before a
 * tool runs, `postToolUse` fires just after it returns. Two ways to hook in:
 *
 * 1. In-process JS handlers via `registerHook` (mainly for tests / embedders
 *    that run Harnes as a library — e.g. a counter++ in a test).
 * 2. Config-defined shell commands (`HookDefinition`) under
 *    `HarnesConfig.hooks.preToolUse` / `.postToolUse`, matched by tool name
 *    (or `"*"` / omitted `match` for every tool) and run with the event
 *    payload as JSON on stdin.
 *
 * Hooks are best-effort and observational for this MVP: a failing or slow
 * hook is logged and never blocks, delays past its timeout, or fails the
 * tool call it wraps.
 */
import { spawn } from "node:child_process";

export type HookEvent = "preToolUse" | "postToolUse";

export interface PreToolUsePayload {
  event: "preToolUse";
  tool: string;
  arguments: Record<string, string>;
}

export interface PostToolUsePayload {
  event: "postToolUse";
  tool: string;
  arguments: Record<string, string>;
  /** The tool's result string (as returned to the model). */
  result: string;
}

export type HookPayload = PreToolUsePayload | PostToolUsePayload;

export type HookHandler = (payload: HookPayload) => void | Promise<void>;

/** A config-defined shell hook. */
export interface HookDefinition {
  /** Tool name to match; omitted or `"*"` matches every tool. */
  match?: string;
  /** Shell command to run; receives the JSON payload on stdin. */
  command: string;
}

/** `HarnesConfig.hooks` shape. */
export interface HooksConfig {
  preToolUse?: HookDefinition[];
  postToolUse?: HookDefinition[];
}

const registry: Record<HookEvent, HookHandler[]> = { preToolUse: [], postToolUse: [] };

/** Registers an in-process JS handler for `event`. Returns an unregister function. */
export function registerHook(event: HookEvent, handler: HookHandler): () => void {
  registry[event].push(handler);
  return () => {
    const list = registry[event];
    const index = list.indexOf(handler);
    if (index !== -1) list.splice(index, 1);
  };
}

/** Clears in-process handlers. Mainly for test teardown. */
export function clearHooks(event?: HookEvent): void {
  if (event) {
    registry[event] = [];
    return;
  }
  registry.preToolUse = [];
  registry.postToolUse = [];
}

const HOOK_TIMEOUT_MS = 5_000;
const HOOK_STDERR_CAP = 2_000;

function matchesTool(def: HookDefinition, tool: string): boolean {
  return !def.match || def.match === "*" || def.match === tool;
}

/**
 * Runs every registered JS handler, then every matching config-defined shell
 * hook, for `event`. Never throws — failures are logged to stderr so a
 * broken hook can't take down a turn.
 */
export async function runHooks(event: HookEvent, payload: HookPayload, defs?: HookDefinition[]): Promise<void> {
  for (const handler of registry[event]) {
    try {
      await handler(payload);
    } catch (error) {
      console.error(`[hooks] ${event} handler threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const def of defs ?? []) {
    if (!matchesTool(def, payload.tool)) continue;
    try {
      await runShellHook(def.command, payload);
    } catch (error) {
      console.error(`[hooks] ${event} "${def.command}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function runShellHook(command: string, payload: HookPayload): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`timed out after ${HOOK_TIMEOUT_MS}ms`));
    }, HOOK_TIMEOUT_MS);

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(0, HOOK_STDERR_CAP);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`exit ${code}${stderr ? `: ${stderr}` : ""}`));
        return;
      }
      resolve();
    });
    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
}
