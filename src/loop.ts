import { isToolAllowed, mcpToolAllowed, MCP_TOOL_PREFIX, type ExecutionBackend, type PermissionMode } from "./exec/types.ts";
import { runHooks, type HooksConfig } from "./hooks.ts";
import type { McpToolProvider } from "./mcp/manager.ts";
import type { ModelSpec } from "./models/catalog.ts";
import { parseCompletionUsage, type CompletionUsage } from "./openrouter/usage.ts";
import { formatSkillList, listSkills, loadSkill } from "./skills.ts";
import { formatTodoList, parseTodoItems, setTodos, type TodoItem } from "./todos.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  /** Present on assistant messages that requested tools (required for multi-turn API history). */
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, string>;
  /** Original JSON values (numbers/booleans/objects) — used for MCP tools/call. */
  typedArguments?: Record<string, unknown>;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: CompletionUsage;
}

export interface CompletionClient {
  complete(input: {
    model: string;
    messages: ChatMessage[];
    tools: { name: string; description: string; parameters?: Record<string, unknown> }[];
    /** When "required", the model must emit at least one tool call (OpenAI/OpenRouter). */
    toolChoice?: "auto" | "required" | "none";
    /** Cancel in-flight HTTP when the REPL aborts (Ctrl+C). */
    signal?: AbortSignal;
  }): Promise<CompletionResult>;
}

export interface LoopResult {
  messages: ChatMessage[];
  steps: number;
  stoppedReason: "complete" | "max-steps" | "denied-tool" | "aborted";
  usage: CompletionUsage;
  /** Final todo list state after this turn (see `todos` input option). */
  todos: TodoItem[];
}

export type LoopProgress =
  | { type: "thinking"; step: number }
  | { type: "tool"; step: number; name: string }
  | { type: "subagent"; step: number; task: string };

/**
 * Tools that must not run concurrently with siblings in the same step.
 * Mutating / shared-state tools serialize the whole step when present.
 */
const SERIAL_ONLY_TOOLS = new Set<string>([
  "write_file",
  "edit_file",
  "todo_write",
  "git_commit",
  "run_tests",
  "delegate",
]);

/** Max number of tool calls from a single step executed concurrently. */
const TOOL_CONCURRENCY_LIMIT = 6;

/** Hard step cap for a `delegate` subagent's own loop, regardless of the parent's maxSteps. */
const SUBAGENT_MAX_STEPS = 6;

/** Hard wall-clock cap for a `delegate` subagent. Exceeding it abandons the child and reports a timeout to the parent. */
export const SUBAGENT_TIMEOUT_MS = 90_000;

/** Subagent nesting depth beyond which `delegate` refuses to spawn a child (MVP: no recursive spawn). */
const SUBAGENT_MAX_DEPTH = 1;

/**
 * Runs `tasks` (in array order) with at most `limit` concurrently in flight.
 * Results are returned in the same order as `tasks`, regardless of finish order.
 */
async function runWithConcurrencyLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Tool schemas advertised to the model (also used by `harnes eval`). */
export const AGENT_TOOLS = [
  {
    name: "read_file",
    description:
      "Read a file from the workspace or sandbox. Optional `offset` (1-based line number to start at) and `limit` (max lines to return) let you read a slice of a large file instead of the whole thing. Without offset/limit, results are capped at 2,000 lines / 20,000 characters; oversized results are cut with a '... truncated N bytes/lines ...' marker — pass offset/limit to page through the rest.",
  },
  { name: "write_file", description: "Write a file in the workspace or sandbox. Use only to create a new file or intentionally overwrite it entirely; prefer edit_file for changes to existing files." },
  {
    name: "edit_file",
    description:
      "Make a precise edit to an existing file by replacing an exact old_string with new_string. old_string must match exactly once in the file (include enough surrounding context to make it unique), unless replace_all is set. Prefer this over write_file for any change to an existing file — it avoids rewriting the whole file for a small change.",
  },
  {
    name: "bash",
    description:
      "Run a shell command. stdout/stderr are capped at 500 lines (head+tail) and 20,000 characters each; oversized output is cut with a truncation marker.",
  },
  {
    name: "glob",
    description: "Search the workspace for files matching a glob pattern. Results are capped at 500 entries.",
  },
  {
    name: "grep",
    description:
      "Search file contents for a regex pattern, optionally scoped by path/glob. Results are capped at 20,000 characters.",
  },
  {
    name: "list_dir",
    description: "List the contents of a directory in the workspace. Results are capped at 500 entries.",
  },
  {
    name: "todo_write",
    description:
      'Replace the session\'s todo list with the given items, e.g. for a multi-step task. `items` is a JSON array of {"id","content","status"}, where status is "pending", "in_progress", or "completed". Pass the FULL desired list each call (not a delta) — omitted ids are dropped. Use for multi-step work so progress is visible; skip it for single-step tasks. Allowed in plan mode (planning is read-only) and build mode.',
  },
  {
    name: "git_status",
    description: "Show the git working tree status (branch + changed/staged/untracked files). Prefer this over running `git status` via bash. Read-only, allowed in plan mode.",
  },
  {
    name: "git_diff",
    description: "Show the git diff, optionally scoped to a `path`. Prefer this over running `git diff` via bash. Output is capped like bash output. Read-only, allowed in plan mode.",
  },
  {
    name: "git_log",
    description: "Show recent commit history (short hash, date, subject). Optional `max_count` (default 20, max 200). Prefer this over running `git log` via bash. Read-only, allowed in plan mode.",
  },
  {
    name: "git_commit",
    description:
      "Stage changes and create a git commit. Requires an explicit `message` (non-empty). Stages all changes by default (`git add -A`); pass stage_all=\"false\" to commit only what's already staged. Never uses --no-verify, --amend, or force push. Prefer this over `git commit`/`git push` via bash. Denied in plan mode.",
  },
  {
    name: "run_tests",
    description:
      'Run the project\'s test/lint/typecheck/build step and get a structured pass/fail verdict. Without arguments, runs the package.json "test" script. Pass `script` ("test", "lint", "typecheck", or "build") to run a different package.json script, or `command` to run an arbitrary shell command instead (overrides `script`). Returns exit code, pass/fail, a one-line summary, and capped combined stdout/stderr. Prefer this over ad hoc `bash` invocations of the test runner so the result is unambiguous. Denied in plan mode.',
  },
  {
    name: "delegate",
    description:
      `Spawn an isolated subagent with its own message list (it does not see your conversation) to explore or build a bounded, self-contained subtask, then return a summary — not its full transcript. Args: \`task\` (required — a clear, self-contained instruction; the subagent has no other context, so include everything it needs), \`mode\` (optional, "plan" (default, read-only explore) or "build"; a subagent can never be more permissive than you are — if you are in plan mode, your subagent is forced to plan mode even if you pass mode="build"), \`model\` (optional — only "inherit" is supported today, and is also the default). The subagent is capped at ${SUBAGENT_MAX_STEPS} steps and a ${Math.round(SUBAGENT_TIMEOUT_MS / 1000)}s timeout, and cannot spawn further subagents (depth limit ${SUBAGENT_MAX_DEPTH}). Use it to offload a self-contained lookup or small patch rather than doing every step yourself; don't use it for work that needs your ongoing conversation context.`,
  },
  {
    name: "skill",
    description:
      'Load an on-demand markdown skill file into context, or list what\'s available. Skills live in .harnes/skills/ (workspace) and ~/.config/harnes/skills/ (user-level); a workspace skill shadows a same-named user skill. Call with no `name` to list available skills; call with `name` set to load that skill\'s body (capped at 8,000 characters, truncated with a marker if longer). Read-only, allowed in plan mode.',
  },
] as const;

/** JSON Schema parameters per tool — without these, models guess arg names and types. */
export const AGENT_TOOL_PARAMETERS: Record<string, Record<string, unknown>> = {
  read_file: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to workspace root" },
      offset: { type: "string", description: "1-based start line (optional)" },
      limit: { type: "string", description: "Max lines to return (optional)" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  write_file: {
    type: "object",
    properties: {
      path: { type: "string" },
      contents: { type: "string" },
    },
    required: ["path", "contents"],
    additionalProperties: false,
  },
  edit_file: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "string", description: 'Set "true" to replace every match' },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  bash: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
    additionalProperties: false,
  },
  glob: {
    type: "object",
    properties: { pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts" } },
    required: ["pattern"],
    additionalProperties: false,
  },
  grep: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern" },
      path: { type: "string", description: "Optional directory/file scope" },
      glob: { type: "string", description: "Optional filename glob filter" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  list_dir: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path (default .)" } },
    additionalProperties: false,
  },
  todo_write: {
    type: "object",
    properties: {
      items: {
        type: "string",
        description: 'JSON array of {"id","content","status"} objects',
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
  git_status: { type: "object", properties: {}, additionalProperties: false },
  git_diff: {
    type: "object",
    properties: { path: { type: "string" } },
    additionalProperties: false,
  },
  git_log: {
    type: "object",
    properties: { max_count: { type: "string", description: "Max commits (default 20)" } },
    additionalProperties: false,
  },
  git_commit: {
    type: "object",
    properties: {
      message: { type: "string" },
      stage_all: { type: "string", description: 'Pass "false" to skip git add -A' },
    },
    required: ["message"],
    additionalProperties: false,
  },
  run_tests: {
    type: "object",
    properties: {
      script: { type: "string", description: "package.json script name (default test)" },
      command: { type: "string", description: "Explicit shell command override" },
    },
    additionalProperties: false,
  },
  delegate: {
    type: "object",
    properties: {
      task: { type: "string" },
      mode: { type: "string", description: 'plan (default) or build' },
      model: { type: "string", description: 'Only "inherit" supported' },
    },
    required: ["task"],
    additionalProperties: false,
  },
  skill: {
    type: "object",
    properties: { name: { type: "string", description: "Skill name; omit to list" } },
    additionalProperties: false,
  },
};

const TOOLS: { name: string; description: string; parameters?: Record<string, unknown> }[] = AGENT_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: AGENT_TOOL_PARAMETERS[tool.name],
}));

function emptyUsage(): CompletionUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
}

function addUsage(into: CompletionUsage, next?: CompletionUsage): void {
  if (!next) return;
  into.promptTokens += next.promptTokens;
  into.completionTokens += next.completionTokens;
  into.totalTokens += next.totalTokens;
  into.costUsd = (into.costUsd ?? 0) + (next.costUsd ?? 0);
}

export async function runAgentLoop(opts: {
  prompt: string;
  model: ModelSpec;
  backend: ExecutionBackend;
  complete: CompletionClient["complete"];
  permissionMode: PermissionMode;
  maxSteps?: number;
  /** Prior conversation turns (without system). Used by the persistent REPL. */
  history?: ChatMessage[];
  onProgress?: (event: LoopProgress) => void;
  /** Return false to deny a tool that needs interactive approval. */
  onApprove?: (call: ToolCall) => Promise<boolean>;
  /**
   * Session todo list. When provided, `todo_write` calls mutate this array
   * in place so the caller (e.g. the REPL, for /todos) sees updates across
   * turns. When omitted, a fresh in-memory list is used for this call only.
   */
  todos?: TodoItem[];
  /**
   * Internal: current subagent nesting depth. Callers (the REPL, `harnes run`)
   * should never set this — it defaults to 0 for a top-level turn. `delegate`
   * sets it to depth + 1 when spawning a child loop, and a child at
   * `SUBAGENT_MAX_DEPTH` refuses to spawn its own subagents.
   */
  subagentDepth?: number;
  /**
   * Internal: overrides SUBAGENT_TIMEOUT_MS for any `delegate` call made at
   * this loop level. Exists mainly so tests can exercise the hard timeout
   * without waiting the real ~90s; the REPL / `harnes run` should never set it.
   */
  subagentTimeoutMs?: number;
  /**
   * Optional MCP tool provider. When set (and it reports servers configured),
   * its tools are namespaced `mcp__<server>__<tool>` and appended to the
   * model's tool list for this turn. Omitted entirely when no MCP servers
   * are configured, so an empty config adds zero overhead ("disabled by
   * default when config empty").
   */
  mcp?: McpToolProvider;
  /** Workspace root used to resolve `.harnes/skills/`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** preToolUse/postToolUse hook definitions from config (see src/hooks.ts). Omitted = no config-defined hooks. */
  hooks?: HooksConfig;
  /** When aborted, the loop stops between steps (REPL Ctrl+C). */
  signal?: AbortSignal;
}): Promise<LoopResult> {
  const maxSteps = opts.maxSteps ?? 24;
  const subagentDepth = opts.subagentDepth ?? 0;
  const todos = opts.todos ?? [];
  const prior = (opts.history ?? []).filter((message) => message.role !== "system");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: systemPrompt(opts.permissionMode, opts.backend.mode),
    },
    ...prior,
    { role: "user", content: opts.prompt },
  ];
  const usage = emptyUsage();
  // Fetched once per turn (not per step): the provider caches its per-server
  // connections/tool lists, so repeat calls across turns are cheap.
  const mcpTools = opts.mcp ? await opts.mcp.listTools() : [];
  const tools = mcpTools.length > 0 ? [...TOOLS, ...mcpTools] : TOOLS;
  let autoContinues = 0;
  let forceTools = false;

  for (let step = 0; step < maxSteps; step += 1) {
    if (opts.signal?.aborted) {
      return { messages, steps: step, stoppedReason: "aborted", usage, todos };
    }
    opts.onProgress?.({ type: "thinking", step: step + 1 });
    const reply = await opts.complete({
      model: opts.model.providerModel,
      messages,
      tools,
      toolChoice: forceTools ? "required" : "auto",
      signal: opts.signal,
    });
    if (opts.signal?.aborted) {
      return { messages, steps: step + 1, stoppedReason: "aborted", usage, todos };
    }
    forceTools = false;
    addUsage(usage, reply.usage);
    messages.push({
      role: "assistant",
      content: reply.content,
      ...(reply.toolCalls.length > 0 ? { tool_calls: reply.toolCalls } : {}),
    });

    if (reply.toolCalls.length === 0) {
      // Weak models often narrate "Let me check…" / ask for "ok" and stop with
      // zero tool calls. Nudge them and force tool_choice=required so the next
      // completion cannot be text-only.
      if (autoContinues < MAX_AUTO_CONTINUES && shouldAutoContinue(reply.content)) {
        autoContinues += 1;
        forceTools = true;
        opts.onProgress?.({ type: "thinking", step: step + 1 });
        messages.push({ role: "user", content: CONTINUE_NUDGE });
        continue;
      }
      return { messages, steps: step + 1, stoppedReason: "complete", usage, todos };
    }

    // Resolve permission + interactive approval sequentially, in model call
    // order, before any tool runs. Approval prompts are user-facing (REPL UI)
    // and must not overlap, so this phase never runs concurrently even
    // though execution below does. A denial fails only that call — it does
    // not cancel sibling calls that have already been kicked off (see loop
    // below), matching the "don't cancel siblings mid-flight" rule.
    type Resolved = { call: ToolCall; denied?: string };
    const resolved: Resolved[] = [];
    for (const call of reply.toolCalls) {
      const allowed = call.name.startsWith(MCP_TOOL_PREFIX)
        ? Boolean(opts.mcp) && mcpToolAllowed(opts.permissionMode, opts.mcp!.classify(call.name))
        : isToolAllowed(opts.permissionMode, call.name);
      if (!allowed) {
        resolved.push({
          call,
          denied: `Tool ${call.name} is not available in ${opts.permissionMode} mode. Pick an allowed tool and continue.`,
        });
        continue;
      }
      if (opts.onApprove && !(await opts.onApprove(call))) {
        resolved.push({
          call,
          denied: `User denied tool ${call.name}. Choose a different approach or ask the user what to do next.`,
        });
        continue;
      }
      resolved.push({ call });
    }

    const runnable = resolved.filter((entry) => !entry.denied);
    if (opts.signal?.aborted) {
      return { messages, steps: step + 1, stoppedReason: "aborted", usage, todos };
    }
    const forceSerial = runnable.some((entry) => SERIAL_ONLY_TOOLS.has(entry.call.name));
    const concurrency = forceSerial ? 1 : TOOL_CONCURRENCY_LIMIT;
    const results = await runWithConcurrencyLimit(
      runnable.map((entry) => async () => {
        if (opts.signal?.aborted) return "Tool error: aborted.";
        opts.onProgress?.({ type: "tool", step: step + 1, name: entry.call.name });
        return await executeTool(
          opts.backend,
          entry.call,
          todos,
          {
            complete: opts.complete,
            model: opts.model,
            permissionMode: opts.permissionMode,
            depth: subagentDepth,
            onProgress: opts.onProgress,
            timeoutMs: opts.subagentTimeoutMs,
            cwd: opts.cwd ?? process.cwd(),
            hooks: opts.hooks,
            signal: opts.signal,
            onApprove: opts.onApprove,
            mcp: opts.mcp,
          },
          opts.mcp
        );
      }),
      concurrency
    );

    // Rebuild the transcript in original model call order (not completion order).
    let runnableIndex = 0;
    for (const entry of resolved) {
      if (entry.denied) {
        messages.push({ role: "tool", tool_call_id: entry.call.id, content: entry.denied });
      } else {
        messages.push({ role: "tool", tool_call_id: entry.call.id, content: results[runnableIndex] });
        runnableIndex += 1;
      }
    }
    // Denials are recoverable: feed the denial text back and let the model continue.
  }

  return { messages, steps: maxSteps, stoppedReason: "max-steps", usage, todos };
}

function systemPrompt(mode: PermissionMode, exec: string): string {
  return [
    // Identity + session state.
    "You are Harnes, the open coding agent.",
    `Permission mode: ${mode}. Execution: ${exec}.`,
    "Use tools rather than guessing, keep changes small, and recover from a failed tool call instead of stopping the turn.",

    // Autonomy — stop the "ok?" micro-step loop.
    "Autonomy: the user should not have to type \"ok\" for you to continue. Keep calling tools in the same turn until the request is fully handled or you are blocked on a real decision only they can make (missing secret, destructive choice, ambiguous product requirement). Never stop after only announcing what you will do next — if you say \"let me check/read/run…\", that tool call must be in the same response. Do not ask \"Shall I proceed?\" / \"Want me to…?\" / \"Say ok to continue\" for routine explore/edit/run work.",

    // Editing: patch-first, whole-file write as the exception.
    "Editing files: prefer edit_file (exact old_string -> new_string replacement) for any change to an existing file — it's precise and cheap to review. Reserve write_file for creating a new file or an intentional full-file rewrite.",

    // Reading: ranged reads + caps, so context isn't wasted.
    "Reading files: read_file supports offset/limit to page through large files; all tool output (read_file, bash, grep, glob, list_dir) is capped and marked with '... truncated ...' when cut, so re-run with a narrower range or pattern instead of assuming truncated output is complete.",

    // Multi-step tracking.
    "Multi-step work: track progress with todo_write — create the list up front, mark an item in_progress before starting it and completed right after it's done. Skip it for trivial single-step requests; don't spam updates.",

    // Git: structured tools over raw bash.
    "Git: prefer git_status/git_diff/git_log/git_commit over raw `git ...` via bash — they're capped and permission-gated correctly. git_commit always requires an explicit message and never force-pushes, amends, or skips hooks.",

    // Verification before declaring done.
    "Verification: before declaring work done, run run_tests (defaults to the package.json \"test\" script; pass script=\"lint\"/\"typecheck\"/\"build\", or an explicit command override, for other checks) instead of guessing pass/fail from bash output.",

    // Subagents: offload bounded, self-contained work.
    "Subagents: delegate spawns an isolated subagent for a bounded, self-contained lookup or small patch — it gets only the `task` text you give it, not your conversation. It's capped in steps/time, can't be more permissive than your own mode, and can't spawn further subagents. Prefer doing multi-step work yourself when it needs your ongoing context; delegate for work you can fully describe in one instruction.",

    // MCP: external tools, namespaced and gated like everything else.
    "MCP tools: any tool named mcp__<server>__<tool> comes from an external MCP server configured in ~/.config/harnes/config.json — use it like a built-in tool. Ones the server or your permission mode can't confirm are read-only may need explicit approval or be unavailable in plan mode.",

    // Skills: on-demand instruction files.
    "Skills: call skill with no arguments to see what's available in .harnes/skills/ and ~/.config/harnes/skills/, or with name set to load one's instructions into context. Use it when a task matches a named skill instead of guessing project conventions.",

    // Tone / honesty.
    "Do not claim frontier-model quality on weak open weights.",
    "When reporting paths to the user, prefer short paths (relative or ~/…) over absolute home paths.",
  ].join(" ");
}

/** Max times we inject a continue nudge when the model stalls with no tool calls. */
const MAX_AUTO_CONTINUES = 8;

export const CONTINUE_NUDGE =
  'Stop narrating. Emit the tool call(s) for the next concrete action NOW (list_dir / read_file / bash / etc). Do not write another "Let me…" / "I\'ll check…" sentence and do not ask for ok/sure/confirmation. Keep going until the user\'s request is fully done.';

/**
 * Detects "Let me check…" / "Should I…?" stalls where the model narrates
 * intent (or asks for confirmation) instead of emitting tool calls.
 */
export function shouldAutoContinue(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  // Closing / finished answers — leave the turn alone.
  if (
    /\b(let me know if|if you need (anything|more)|hope (that|this) helps|you('re| are) all set|already running|server is (up|running)|created successfully|here('s| is) (the|what)|fixed\.|done\.|complete\.)\b/i.test(
      text
    )
  ) {
    return false;
  }
  // Explanatory prose ("First, let me explain…") is not a stall — don't force tools.
  if (
    /\b(let me (explain|clarify|summarize|outline|describe|walk (you )?through)|i('ll| will) (explain|clarify|summarize)|here('s| is) (how|why|what))\b/i.test(
      text
    )
  ) {
    return false;
  }
  if (
    /\b(should i|shall i|want me to|may i|can i (proceed|continue)|say (ok|okay|yes) (to|when)|waiting for (your|you)|tell me (if|when) to|ok to (continue|proceed)\??)\b/i.test(
      text
    )
  ) {
    return true;
  }
  if (
    /\b(let me (try|check|see|read|look|run|start|create|open|find|inspect|list|verify|spin)|i('ll| will) (now )?(check|read|try|look|run|start|create|open|find|inspect)|first[, ]+(let me|i('ll| will)|i need to)|next[, ]+(i('ll| will)|let me))\b/i.test(
      text
    )
  ) {
    return true;
  }
  return false;
}

/** Context an in-flight loop passes down to `executeTool` so `delegate` can spawn a child loop. */
interface SubagentContext {
  complete: CompletionClient["complete"];
  model: ModelSpec;
  permissionMode: PermissionMode;
  depth: number;
  onProgress?: (event: LoopProgress) => void;
  /** Overrides SUBAGENT_TIMEOUT_MS for this call's own `delegate` spawns (tests only). */
  timeoutMs?: number;
  /** Workspace root used to resolve `.harnes/skills/` for the `skill` tool. */
  cwd: string;
  /** preToolUse/postToolUse hook definitions from config, threaded down to a `delegate` child loop too. */
  hooks?: HooksConfig;
  mcp?: McpToolProvider;
  signal?: AbortSignal;
  onApprove?: (call: ToolCall) => Promise<boolean>;
}

async function executeTool(
  backend: ExecutionBackend,
  call: ToolCall,
  todos: TodoItem[],
  subagent: SubagentContext,
  mcp?: McpToolProvider
): Promise<string> {
  await runHooks(
    "preToolUse",
    { event: "preToolUse", tool: call.name, arguments: call.arguments },
    subagent.hooks?.preToolUse
  );
  const result = await dispatchTool(backend, call, todos, subagent, mcp);
  await runHooks(
    "postToolUse",
    { event: "postToolUse", tool: call.name, arguments: call.arguments, result },
    subagent.hooks?.postToolUse
  );
  return result;
}

async function dispatchTool(
  backend: ExecutionBackend,
  call: ToolCall,
  todos: TodoItem[],
  subagent: SubagentContext,
  mcp?: McpToolProvider
): Promise<string> {
  try {
    if (call.name.startsWith(MCP_TOOL_PREFIX)) {
      if (!mcp) return "Tool error: no MCP servers are configured.";
      return await mcp.callTool(call.name, call.typedArguments ?? call.arguments);
    }
    if (call.name === "read_file") {
      const filePath = (call.arguments.path ?? "").trim();
      if (!filePath) return "Tool error: read_file requires a non-empty path.";
      const offset = parsePositiveInt(call.arguments.offset);
      const limit = parsePositiveInt(call.arguments.limit);
      const hasOptions = offset !== undefined || limit !== undefined;
      return await backend.readFile(filePath, hasOptions ? { offset, limit } : undefined);
    }
    if (call.name === "write_file") {
      const filePath = (call.arguments.path ?? "").trim();
      if (!filePath) return "Tool error: write_file requires a non-empty path.";
      await backend.writeFile(filePath, call.arguments.contents ?? "");
      return `Wrote ${filePath}`;
    }
    if (call.name === "edit_file") {
      const filePath = (call.arguments.path ?? "").trim();
      if (!filePath) return "Tool error: edit_file requires a non-empty path.";
      const replaceAll = parseTruthy(call.arguments.replace_all);
      const result = await backend.editFile(
        filePath,
        call.arguments.old_string ?? "",
        call.arguments.new_string ?? "",
        replaceAll
      );
      return `Edited ${filePath} (${result.replacements} replacement${result.replacements === 1 ? "" : "s"})`;
    }
    if (call.name === "bash") {
      const command = (call.arguments.command ?? "").trim();
      if (!command) return "Tool error: bash requires a non-empty command.";
      const result = await backend.run(command);
      const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : "";
      return `exit ${result.exitCode}\n${result.stdout}${stderr}`;
    }
    if (call.name === "glob") {
      const pattern = (call.arguments.pattern ?? "").trim();
      if (!pattern) return "Tool error: glob requires a non-empty pattern.";
      const matches = await backend.glob(pattern);
      return matches.length > 0 ? matches.join("\n") : "No matches.";
    }
    if (call.name === "grep") {
      const pattern = call.arguments.pattern ?? "";
      if (!pattern.trim()) return "Tool error: grep requires a non-empty pattern.";
      return await backend.grep(pattern, call.arguments.path, call.arguments.glob);
    }
    if (call.name === "list_dir") {
      const dirPath = call.arguments.path;
      if (dirPath !== undefined && dirPath.trim() === "") {
        return "Tool error: list_dir path must not be an empty string (omit path for cwd, or pass '.').";
      }
      const entries = await backend.listDir(dirPath);
      return entries.length > 0 ? entries.join("\n") : "(empty directory)";
    }
    if (call.name === "todo_write") {
      const items = parseTodoItems(call.arguments.items);
      setTodos(todos, items);
      return `Todos updated:\n${formatTodoList(todos)}`;
    }
    if (call.name === "git_status") {
      return await backend.gitStatus();
    }
    if (call.name === "git_diff") {
      return await backend.gitDiff(call.arguments.path);
    }
    if (call.name === "git_log") {
      const maxCount = parsePositiveInt(call.arguments.max_count);
      return await backend.gitLog(maxCount);
    }
    if (call.name === "git_commit") {
      const stageAll = !parseFalsy(call.arguments.stage_all);
      const result = await backend.gitCommit(call.arguments.message ?? "", { stageAll });
      return `Committed ${result.commit}${result.summary ? `\n${result.summary}` : ""}`;
    }
    if (call.name === "run_tests") {
      const command = call.arguments.command && call.arguments.command.trim() !== "" ? call.arguments.command : undefined;
      const script = call.arguments.script && call.arguments.script.trim() !== "" ? call.arguments.script : undefined;
      const result = await backend.runCheck({ command, script });
      return `${result.summary}\n${result.output}`;
    }
    if (call.name === "delegate") {
      return await runDelegate(backend, call, subagent);
    }
    if (call.name === "skill") {
      const name = (call.arguments.name ?? "").trim();
      if (!name) {
        const skills = await listSkills(subagent.cwd);
        return `Skills:\n${formatSkillList(skills)}`;
      }
      return await loadSkill(name, subagent.cwd);
    }
    return `Unknown tool ${call.name}`;
  } catch (error) {
    return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Runs a `delegate` tool call: spawns an isolated child `runAgentLoop` with its
 * own message list (only `task` as the prompt, no parent history), capped
 * steps/timeout, and depth-limited to MVP's "no recursive spawn" rule. Returns
 * a short summary (final assistant message + files touched) instead of the
 * child's full transcript.
 */
async function runDelegate(backend: ExecutionBackend, call: ToolCall, subagent: SubagentContext): Promise<string> {
  const task = (call.arguments.task ?? "").trim();
  if (!task) {
    return "Tool error: delegate requires a non-empty `task` describing the subagent's work.";
  }
  if (subagent.depth >= SUBAGENT_MAX_DEPTH) {
    return `Tool error: subagents cannot spawn further subagents (depth limit ${SUBAGENT_MAX_DEPTH}).`;
  }

  const requestedMode: PermissionMode = call.arguments.mode === "build" ? "build" : "plan";
  // Mode inheritance: a subagent can never be more permissive than its parent.
  // A plan-mode parent is forced to spawn a plan-mode child even if it asks for "build".
  const childPermissionMode: PermissionMode = subagent.permissionMode === "plan" ? "plan" : requestedMode;
  const modelNote =
    call.arguments.model && call.arguments.model !== "inherit"
      ? " (model override not supported yet; used the parent's model)"
      : "";

  subagent.onProgress?.({ type: "subagent", step: 0, task: task.length > 80 ? `${task.slice(0, 77)}...` : task });

  // Track files the child mutates so the parent gets a touch list instead of the raw transcript.
  const touched: string[] = [];
  const trackingBackend: ExecutionBackend = {
    mode: backend.mode,
    run: (command, cwd) => backend.run(command, cwd),
    readFile: (path, options) => backend.readFile(path, options),
    writeFile: async (path, contents) => {
      touched.push(path);
      return backend.writeFile(path, contents);
    },
    editFile: async (path, oldString, newString, replaceAll) => {
      touched.push(path);
      return backend.editFile(path, oldString, newString, replaceAll);
    },
    glob: (pattern) => backend.glob(pattern),
    grep: (pattern, path, glob) => backend.grep(pattern, path, glob),
    listDir: (path) => backend.listDir(path),
    gitStatus: () => backend.gitStatus(),
    gitDiff: (path) => backend.gitDiff(path),
    gitLog: (maxCount) => backend.gitLog(maxCount),
    gitCommit: async (message, options) => {
      const result = await backend.gitCommit(message, options);
      touched.push(`(git commit ${result.commit})`);
      return result;
    },
    runCheck: (options) => backend.runCheck(options),
    close: () => backend.close(),
  };

  const childAbort = new AbortController();
  const onParentAbort = () => childAbort.abort();
  subagent.signal?.addEventListener("abort", onParentAbort, { once: true });

  const childLoop = runAgentLoop({
    prompt: task,
    model: subagent.model,
    backend: trackingBackend,
    complete: subagent.complete,
    permissionMode: childPermissionMode,
    maxSteps: SUBAGENT_MAX_STEPS,
    subagentDepth: subagent.depth + 1,
    cwd: subagent.cwd,
    hooks: subagent.hooks,
    signal: childAbort.signal,
    onApprove: subagent.onApprove,
    mcp: subagent.mcp,
  });

  const timeoutMs = subagent.timeoutMs ?? SUBAGENT_TIMEOUT_MS;
  const timedOut = Symbol("subagent-timeout");
  const outcome = await Promise.race([
    childLoop,
    new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
  ]);

  subagent.signal?.removeEventListener("abort", onParentAbort);

  if (outcome === timedOut) {
    childAbort.abort();
    return `Subagent timed out after ${Math.round(timeoutMs / 1000)}s in ${childPermissionMode} mode${modelNote}. Any partial work it did is not reflected here — check git_status/git_diff if it may have written files.`;
  }

  const result = outcome;
  const lastAssistant = [...result.messages].reverse().find((message) => message.role === "assistant" && message.content);
  const summary = lastAssistant?.content?.trim() || "(subagent produced no final message)";
  const fileList = touched.length > 0 ? touched.map((file) => `- ${file}`).join("\n") : "(no files touched)";
  const usageNote =
    result.usage.costUsd || result.usage.totalTokens
      ? `\n(usage: ${result.usage.promptTokens} in / ${result.usage.completionTokens} out${result.usage.costUsd ? ` · $${result.usage.costUsd.toFixed(4)}` : ""})`
      : "";
  return [
    `Subagent done (${childPermissionMode} mode, ${result.steps} step${result.steps === 1 ? "" : "s"}, ${result.stoppedReason}${modelNote}):`,
    summary,
    "",
    "Files touched:",
    fileList + usageNote,
  ].join("\n");
}

export async function openaiCompatibleComplete(
  baseUrl: string,
  apiKey: string | undefined,
  input: Parameters<CompletionClient["complete"]>[0],
  fetchImpl: typeof fetch = fetch
): Promise<CompletionResult> {
  if (input.signal?.aborted) {
    throw new Error("Model request aborted.");
  }
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "HTTP-Referer": "https://openharnes.com",
      "X-OpenRouter-Title": "Harnes",
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages.map((message) => {
        if (message.role === "assistant" && message.tool_calls?.length) {
          return {
            role: "assistant",
            content: message.content || null,
            tool_calls: message.tool_calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
            })),
          };
        }
        if (message.role === "tool") {
          return { role: "tool", tool_call_id: message.tool_call_id, content: message.content };
        }
        return { role: message.role, content: message.content };
      }),
      tools: input.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? { type: "object", additionalProperties: true },
        },
      })),
      ...(input.toolChoice ? { tool_choice: input.toolChoice } : {}),
      // OpenRouter returns usage.cost when this is set / by default for non-streaming.
      usage: { include: true },
    }),
    signal: input.signal,
  });
  if (input.signal?.aborted) {
    throw new Error("Model request aborted.");
  }
  if (!response.ok) {
    throw new Error(`Model endpoint failed (${response.status}): ${await response.text()}`);
  }
  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
    usage?: unknown;
    error?: { message?: string };
  };
  if (json.error?.message) {
    throw new Error(`Model endpoint error: ${json.error.message}`);
  }
  if (!json.choices?.length) {
    throw new Error("Model endpoint returned no choices (empty response).");
  }
  const message = json.choices[0]?.message;
  const toolCalls: ToolCall[] =
    message?.tool_calls?.map((call) => {
      const typed = parseTypedToolArguments(call.function.arguments);
      return {
        id: call.id,
        name: call.function.name,
        arguments: coerceToolArguments(call.function.arguments),
        typedArguments: typed,
      };
    }) ?? [];
  return {
    content: message?.content ?? "",
    toolCalls,
    usage: parseCompletionUsage(json.usage),
  };
}

/** Parses a tool argument string into a positive integer, or undefined if absent/invalid. */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** True for true/1/yes/on (case-insensitive). Handles boolean JSON coerced to string. */
function parseTruthy(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/** True for false/0/no/off. */
function parseFalsy(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false;
  const v = raw.trim().toLowerCase();
  return v === "false" || v === "0" || v === "no" || v === "off";
}

/** Coerce tool-call JSON args to string map (models often emit booleans/numbers). */
export function coerceToolArguments(raw: string): Record<string, string> {
  const typed = parseTypedToolArguments(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(typed)) {
    if (value === null || value === undefined) {
      out[key] = "";
    } else if (typeof value === "string") {
      out[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    } else {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}

/** Keep typed JSON values for MCP tools that expect numbers/booleans/objects. */
export function parseTypedToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeJson(raw: string): Record<string, string> {
  return coerceToolArguments(raw);
}
