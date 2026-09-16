import { isToolAllowed, type ExecutionBackend, type PermissionMode } from "./exec/types.ts";
import type { ModelSpec } from "./models/catalog.ts";
import { parseCompletionUsage, type CompletionUsage } from "./openrouter/usage.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, string>;
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
    tools: { name: string; description: string }[];
  }): Promise<CompletionResult>;
}

export interface LoopResult {
  messages: ChatMessage[];
  steps: number;
  stoppedReason: "complete" | "max-steps" | "denied-tool";
  usage: CompletionUsage;
}

export type LoopProgress =
  | { type: "thinking"; step: number }
  | { type: "tool"; step: number; name: string };

const TOOLS = [
  { name: "read_file", description: "Read a file from the workspace or sandbox." },
  { name: "write_file", description: "Write a file in the workspace or sandbox." },
  { name: "bash", description: "Run a shell command." },
  { name: "glob", description: "Search the workspace for files matching a glob pattern." },
  { name: "grep", description: "Search file contents for a regex pattern, optionally scoped by path/glob." },
  { name: "list_dir", description: "List the contents of a directory in the workspace." },
];

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
}): Promise<LoopResult> {
  const maxSteps = opts.maxSteps ?? 12;
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

  for (let step = 0; step < maxSteps; step += 1) {
    opts.onProgress?.({ type: "thinking", step: step + 1 });
    const reply = await opts.complete({
      model: opts.model.providerModel,
      messages,
      tools: TOOLS,
    });
    addUsage(usage, reply.usage);
    messages.push({ role: "assistant", content: reply.content });

    if (reply.toolCalls.length === 0) {
      return { messages, steps: step + 1, stoppedReason: "complete", usage };
    }

    for (const call of reply.toolCalls) {
      if (!isToolAllowed(opts.permissionMode, call.name)) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Tool ${call.name} is not available in ${opts.permissionMode} mode.`,
        });
        return { messages, steps: step + 1, stoppedReason: "denied-tool", usage };
      }
      opts.onProgress?.({ type: "tool", step: step + 1, name: call.name });
      const result = await executeTool(opts.backend, call);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  return { messages, steps: maxSteps, stoppedReason: "max-steps", usage };
}

function systemPrompt(mode: PermissionMode, exec: string): string {
  return [
    "You are Harnes, the open coding agent.",
    `Permission mode: ${mode}. Execution: ${exec}.`,
    "Use tools. Prefer small diffs. Recover from failed tool calls instead of stopping.",
    "Do not claim frontier-model quality on weak open weights.",
    "When reporting paths to the user, prefer short paths (relative or ~/…) over absolute home paths.",
  ].join(" ");
}

async function executeTool(backend: ExecutionBackend, call: ToolCall): Promise<string> {
  try {
    if (call.name === "read_file") {
      return await backend.readFile(call.arguments.path ?? "");
    }
    if (call.name === "write_file") {
      await backend.writeFile(call.arguments.path ?? "", call.arguments.contents ?? "");
      return `Wrote ${call.arguments.path}`;
    }
    if (call.name === "bash") {
      const result = await backend.run(call.arguments.command ?? "");
      return `exit ${result.exitCode}\n${result.stdout}${result.stderr}`;
    }
    if (call.name === "glob") {
      const matches = await backend.glob(call.arguments.pattern ?? "**");
      return matches.length > 0 ? matches.join("\n") : "No matches.";
    }
    if (call.name === "grep") {
      return await backend.grep(call.arguments.pattern ?? "", call.arguments.path, call.arguments.glob);
    }
    if (call.name === "list_dir") {
      const entries = await backend.listDir(call.arguments.path);
      return entries.length > 0 ? entries.join("\n") : "(empty directory)";
    }
    return `Unknown tool ${call.name}`;
  } catch (error) {
    return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function openaiCompatibleComplete(
  baseUrl: string,
  apiKey: string | undefined,
  input: Parameters<CompletionClient["complete"]>[0],
  fetchImpl: typeof fetch = fetch
): Promise<CompletionResult> {
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
      messages: input.messages,
      tools: input.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: { type: "object", additionalProperties: true } },
      })),
      // OpenRouter returns usage.cost when this is set / by default for non-streaming.
      usage: { include: true },
    }),
  });
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
  };
  const message = json.choices?.[0]?.message;
  const toolCalls: ToolCall[] =
    message?.tool_calls?.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: safeJson(call.function.arguments),
    })) ?? [];
  return {
    content: message?.content ?? "",
    toolCalls,
    usage: parseCompletionUsage(json.usage),
  };
}

function safeJson(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}
