import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveChatEndpoint, type HarnesConfig } from "../config.ts";
import { LocalBackend } from "../exec/local.ts";
import {
  AGENT_TOOL_PARAMETERS,
  AGENT_TOOLS,
  openaiCompatibleComplete,
  runAgentLoop,
  type ChatMessage,
  type ToolCall,
} from "../loop.ts";
import { getModel, wireModelId } from "../models/catalog.ts";
import { scoreOutcomeChecks } from "./outcome.ts";
import { scoreToolCalls } from "./score.ts";
import type { EvalReport, EvalTask, TaskScore } from "./types.ts";

const execFileAsync = promisify(execFile);

const EVALS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../evals");
const DEFAULT_TASKS_DIR = path.join(EVALS_ROOT, "tasks");
const DEFAULT_GOLDENS = path.join(EVALS_ROOT, "fixtures/goldens.json");

export type RecordedCalls = Array<{ name: string; arguments: Record<string, string> }>;
export type LiveEvalMode = "loop" | "first-step";

export function defaultTasksDir(): string {
  return process.env.HARNES_EVAL_TASKS ?? DEFAULT_TASKS_DIR;
}

export async function loadGoldens(file = process.env.HARNES_EVAL_GOLDENS ?? DEFAULT_GOLDENS): Promise<Record<string, RecordedCalls>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, RecordedCalls>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function loadTasks(dir = defaultTasksDir()): Promise<EvalTask[]> {
  const entries = await readdir(dir);
  const tasks: EvalTask[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".json")) continue;
    const raw = JSON.parse(await readFile(path.join(dir, name), "utf8")) as EvalTask;
    if (!raw.id || typeof raw.prompt !== "string" || !Array.isArray(raw.expect)) {
      throw new Error(`Invalid eval task ${name}: need id, prompt, expect[]`);
    }
    tasks.push(raw);
  }
  return tasks;
}

function systemPromptForEval(): string {
  return [
    "You are Harnes, the open coding agent under evaluation.",
    "Respond with tool calls when the user asks you to inspect or change the workspace.",
    "Prefer list_dir / read_file / glob / grep / edit_file over narrating intent.",
    "Do not ask for confirmation. If no tool is needed (pure chit-chat), reply with text only and no tools.",
  ].join(" ");
}

function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant" && messages[i].content.trim()) return messages[i].content;
  }
  return "";
}

function combineScore(toolScore: number, hasTools: boolean, checkScore: number, hasChecks: boolean): number {
  if (hasTools && hasChecks) return (toolScore + checkScore) / 2;
  if (hasChecks) return checkScore;
  return toolScore;
}

/**
 * Single completion — BFCL-style first-step tool-call accuracy only. Tools are not executed.
 */
export async function runFirstStepTask(
  task: EvalTask,
  config: HarnesConfig,
  modelId?: string
): Promise<TaskScore> {
  const endpoint = resolveChatEndpoint(config);
  const model = getModel(modelId ?? config.pinnedModelId ?? "qwen3-coder-30b");
  const wire = wireModelId(model, endpoint.provider);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPromptForEval() },
    { role: "user", content: task.prompt },
  ];
  const reply = await openaiCompatibleComplete(endpoint.baseUrl, endpoint.apiKey, {
    model: wire,
    messages,
    tools: AGENT_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: AGENT_TOOL_PARAMETERS[tool.name],
    })),
    toolChoice: "auto",
  });
  const scored = scoreToolCalls(
    task.id,
    task.expect,
    reply.toolCalls.map((call: ToolCall) => ({ name: call.name, arguments: call.arguments })),
    { ordered: task.ordered, content: reply.content }
  );
  return { ...scored, mode: "first-step" };
}

/** @deprecated Use runFirstStepTask */
export const runLiveTask = runFirstStepTask;

async function seedWorkspace(root: string, setup: EvalTask["setup"]): Promise<void> {
  if (!setup) return;
  if (setup.files) {
    for (const [rel, body] of Object.entries(setup.files)) {
      const abs = path.join(root, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, body);
    }
  }
  if (setup.gitInit) {
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "eval@openharnes.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Harnes Eval"], { cwd: root });
    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await execFileAsync("git", ["commit", "-q", "--allow-empty", "-m", "eval seed"], { cwd: root });
  }
}

/**
 * Full agent loop in a temp workspace: tools execute, then we score trajectory
 * tool calls + optional post-run outcome checks.
 */
export async function runLoopTask(
  task: EvalTask,
  config: HarnesConfig,
  modelId?: string
): Promise<TaskScore> {
  const endpoint = resolveChatEndpoint(config);
  const model = getModel(modelId ?? config.pinnedModelId ?? "qwen3-coder-30b");
  const wire = wireModelId(model, endpoint.provider);
  const root = await mkdtemp(path.join(tmpdir(), `harnes-eval-${task.id}-`));
  const backend = new LocalBackend(root);
  const seen: RecordedCalls = [];

  try {
    await seedWorkspace(root, task.setup);
    const result = await runAgentLoop({
      prompt: task.prompt,
      model: { ...model, providerModel: wire },
      backend,
      permissionMode: "build",
      maxSteps: task.maxSteps ?? 8,
      cwd: root,
      onApprove: async () => true,
      complete: async (input) => {
        const reply = await openaiCompatibleComplete(endpoint.baseUrl, endpoint.apiKey, input);
        for (const call of reply.toolCalls) {
          seen.push({ name: call.name, arguments: call.arguments });
        }
        return reply;
      },
    });

    const finalContent = lastAssistantText(result.messages);
    const toolScore = scoreToolCalls(task.id, task.expect, seen, {
      ordered: task.ordered,
      content: finalContent,
    });

    const checks = task.checks?.length
      ? await scoreOutcomeChecks(task.checks, { workspaceRoot: root, finalContent })
      : [];
    const checksPassed = checks.filter((c) => c.passed).length;
    const checkScore = checks.length === 0 ? 1 : checksPassed / checks.length;
    const toolsOk = toolScore.passed;
    const checksOk = checks.length === 0 || checksPassed === checks.length;
    const score = combineScore(toolScore.score, true, checkScore, checks.length > 0);

    return {
      ...toolScore,
      passed: toolsOk && checksOk,
      score,
      contentPreview: finalContent.slice(0, 160) || toolScore.contentPreview,
      checks,
      steps: result.steps,
      mode: "loop",
    };
  } finally {
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Offline: score a recorded actual[] against the task (no network). */
export function scoreFixtureTask(task: EvalTask, actual: RecordedCalls, content?: string): TaskScore {
  const scored = scoreToolCalls(task.id, task.expect, actual, { ordered: task.ordered, content });
  return { ...scored, mode: "fixture" };
}

export async function runEvalSuite(opts: {
  config: HarnesConfig;
  live: boolean;
  /** Default for live is full loop + outcome checks. */
  liveMode?: LiveEvalMode;
  modelId?: string;
  tags?: string[];
  taskIds?: string[];
  tasksDir?: string;
  fixtures?: Record<string, RecordedCalls>;
}): Promise<EvalReport> {
  let tasks = await loadTasks(opts.tasksDir ?? defaultTasksDir());
  if (opts.tags?.length) {
    tasks = tasks.filter((task) => opts.tags!.some((tag) => task.tags?.includes(tag)));
  }
  if (opts.taskIds?.length) {
    const want = new Set(opts.taskIds);
    tasks = tasks.filter((task) => want.has(task.id));
  }

  const modelLabel = opts.modelId ?? opts.config.pinnedModelId ?? "qwen3-coder-30b";
  const liveMode: LiveEvalMode = opts.liveMode ?? "loop";
  const scores: TaskScore[] = [];
  const fixtures = opts.live ? undefined : (opts.fixtures ?? (await loadGoldens()));

  for (const task of tasks) {
    if (opts.live) {
      scores.push(
        liveMode === "first-step"
          ? await runFirstStepTask(task, opts.config, opts.modelId)
          : await runLoopTask(task, opts.config, opts.modelId)
      );
    } else {
      scores.push(scoreFixtureTask(task, fixtures?.[task.id] ?? []));
    }
  }

  const passed = scores.filter((score) => score.passed).length;
  const failed = scores.length - passed;
  const accuracy = scores.length === 0 ? 0 : scores.reduce((sum, s) => sum + s.score, 0) / scores.length;

  return {
    model: modelLabel,
    mode: opts.live ? (liveMode === "first-step" ? "live-first-step" : "live-loop") : "fixture",
    tasks: scores,
    passed,
    failed,
    accuracy,
  };
}

export function formatEvalReport(report: EvalReport): string {
  const lines = [
    `Harnes tool-call eval  ·  model=${report.model}  ·  mode=${report.mode}`,
    `accuracy ${(report.accuracy * 100).toFixed(1)}%  ·  ${report.passed} passed / ${report.failed} failed / ${report.tasks.length} tasks`,
    "",
  ];
  for (const task of report.tasks) {
    const mark = task.passed ? "PASS" : "FAIL";
    const stepBit = task.steps != null ? `  steps=${task.steps}` : "";
    lines.push(
      `[${mark}] ${task.taskId}  score=${task.score.toFixed(2)}  matched ${task.matchedCount}/${task.expectedCount}${stepBit}`
    );
    if (task.checks?.length) {
      for (const check of task.checks) {
        lines.push(`       ${check.passed ? "✓" : "✗"} ${check.detail}`);
      }
    }
    if (!task.passed) {
      for (const call of task.calls.filter((c) => !c.matched)) {
        lines.push(`       - ${call.expected.name}: ${call.detail}`);
      }
      if (task.actual.length === 0 && task.contentPreview) {
        lines.push(`       - model text: ${JSON.stringify(task.contentPreview)}`);
      }
      if (task.unexpected.length) {
        lines.push(`       - unexpected: ${task.unexpected.join(", ")}`);
      }
    } else if (task.mode === "loop" && task.contentPreview) {
      lines.push(`       final: ${JSON.stringify(task.contentPreview.slice(0, 100))}`);
    }
  }
  return lines.join("\n");
}
