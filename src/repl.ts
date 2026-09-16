import * as os from "node:os";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  hasUsableApiKey,
  resolveChatEndpoint,
  saveConfig,
  type HarnesConfig,
} from "./config.ts";
import { LocalBackend } from "./exec/local.ts";
import { openaiCompatibleComplete, runAgentLoop, type ChatMessage } from "./loop.ts";
import { getModel, listOpenRouterModels, MODEL_CATALOG, OPENROUTER_BASE_URL, OLLAMA_BASE_URL, normalizeModelId } from "./models/catalog.ts";
import { ONE_LINER, PRODUCT_NAME, SHORT_NAME } from "./positioning.ts";
import {
  formatFooterLines,
  formatTokenBar,
  normalizeSessionMode,
  resolveSession,
  type SessionUsage,
} from "./session.ts";
import type { SessionMode } from "./exec/types.ts";

export type { SessionUsage };

const VERSION = "0.1.7";
const FOOTER_ROWS = 3; // separator + 2 status lines

const SLASH_COMMANDS: Array<{ cmd: string; help: string }> = [
  { cmd: "/help", help: "show commands" },
  { cmd: "/setup", help: "configure OpenRouter or Ollama" },
  { cmd: "/status", help: "model, mode, context, cwd" },
  { cmd: "/model", help: "show / pin active model" },
  { cmd: "/model auto", help: "route per prompt" },
  { cmd: "/models", help: "list catalog" },
  { cmd: "/mode", help: "auto | plan | build" },
  { cmd: "/usage", help: "session usage" },
  { cmd: "/clear", help: "reset conversation memory" },
  { cmd: "/exit", help: "quit" },
];

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  // Cool charcoal chrome (not green)
  accent: "\x1b[38;5;246m",
  accentBright: "\x1b[38;5;252m",
  muted: "\x1b[38;5;243m",
  cmd: "\x1b[38;5;147m",
  soft: "\x1b[38;5;150m", // soft lime for model line
  warm: "\x1b[38;5;215m", // amber for mode line
  // Input bar ≈ #1a2024
  inputBg: "\x1b[48;2;26;32;36m",
  inputFg: "\x1b[38;5;252m",
};

function paint(color: string, text: string): string {
  return `${color}${text}${ansi.reset}`;
}

function shortCwd(cwd: string): string {
  const home = os.homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function visibleWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padLine(content: string, inner: number): string {
  const pad = Math.max(0, inner - visibleWidth(content));
  return content + " ".repeat(pad);
}

function promptPrefix(): string {
  return `${ansi.inputBg}${ansi.inputFg}${ansi.bold} › ${ansi.reset}${ansi.inputBg}${ansi.inputFg}`;
}

export async function startRepl(initialConfig: HarnesConfig): Promise<void> {
  let config = initialConfig;
  const cwd = process.cwd();
  const backend = new LocalBackend(cwd);
  const history: ChatMessage[] = [];
  const usage: SessionUsage = { turns: 0, agentSteps: 0, toolCalls: 0 };

  if (!process.stdin.isTTY) {
    console.error("Persistent session needs a TTY. Use `harnes run \"...\"` for one-shot.");
    await backend.close();
    process.exitCode = 1;
    return;
  }

  const firstRun = !config.setupComplete || !hasUsableApiKey(config);
  if (firstRun) {
    printWelcomeBox(config, cwd, history, { firstRun: true });
    config = await runSetup(config, { nested: false });
  }

  if (config.pinnedModelId) {
    try {
      getModel(config.pinnedModelId);
    } catch {
      const bad = config.pinnedModelId;
      const next = { ...config };
      delete next.pinnedModelId;
      config = next;
      await saveConfig(config);
      console.log(paint(ansi.warm, `Cleared invalid pinned model '${bad}'. Using auto-route.`));
      console.log("");
    }
  }

  printWelcomeBox(config, cwd, history, { firstRun: false });

  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
    completer: slashCompleter,
  });

  const showIdle = () => {
    const session = resolveSession(config, history);
    const width = Math.min(process.stdout.columns || 80, 88);
    const [line1, line2] = formatFooterLines(session);
    const plainPrompt = " › ";
    rl.setPrompt(promptPrefix());
    output.write(ansi.reset);
    // Always start the prompt at column 0 (cursor-up left the caret mid-line before).
    output.write("\r\x1b[0K");
    rl.prompt();
    // Status sits BELOW the input bar (WOZ-style)
    output.write(
      `\n${paint(ansi.dim, "─".repeat(width))}\n` +
        `${paint(ansi.soft, line1)}\n` +
        `${paint(ansi.warm, line2)}`
    );
    // Return to the input line and park the caret after the prompt glyph.
    output.write(`\x1b[${FOOTER_ROWS}A\x1b[${plainPrompt.length + 1}G`);
  };

  const clearBelowInput = () => {
    // Drop the parked footer after Enter so the transcript stays clean
    output.write(`${ansi.reset}\r\x1b[0J\n`);
  };

  const shutdown = async () => {
    output.write(ansi.reset);
    rl.close();
    await backend.close();
    printUsage(usage, config, history);
  };

  rl.on("SIGINT", () => {
    clearBelowInput();
    output.write(`${paint(ansi.muted, "(interrupted — /clear to reset, /exit to quit)")}\n`);
    showIdle();
  });

  showIdle();

  for await (const line of rl) {
    clearBelowInput();
    const text = line.trim();
    if (!text) {
      showIdle();
      continue;
    }

    if (text === "/") {
      printSlashMenu();
      showIdle();
      continue;
    }

    if (text.startsWith("/")) {
      const done = await handleSlash(text, {
        getConfig: () => config,
        setConfig: async (next) => {
          config = next;
          await saveConfig(config);
        },
        history,
        usage,
        cwd,
      });
      if (done === "exit") break;
      showIdle();
      continue;
    }

    try {
      await runTurn(text, config, backend, history, usage);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    showIdle();
  }

  await shutdown();
}

function slashCompleter(line: string): [string[], string] {
  const hits = SLASH_COMMANDS.map((c) => c.cmd).filter((c) => c.startsWith(line));
  return [hits.length ? hits : SLASH_COMMANDS.map((c) => c.cmd), line];
}

function printWelcomeBox(
  config: HarnesConfig,
  cwd: string,
  history: ChatMessage[],
  opts: { firstRun: boolean }
): void {
  const cols = Math.min(process.stdout.columns || 88, 92);
  const inner = Math.max(40, cols - 4);
  const session = resolveSession(config, history);
  const title = ` ${SHORT_NAME} v${VERSION} `;
  const top =
    paint(ansi.accent, "╭─") +
    paint(ansi.accentBright, title) +
    paint(ansi.accent, "─".repeat(Math.max(1, inner - title.length - 1)) + "╮");
  const bot = paint(ansi.accent, "╰" + "─".repeat(inner + 1) + "╯");
  const edge = () => paint(ansi.accent, "│");

  const left: string[] = [
    paint(ansi.bold, `Welcome to ${SHORT_NAME}`),
    "",
    paint(ansi.soft, "◆"),
    paint(ansi.muted, `${session.model.name} · ${session.mode}`),
    paint(ansi.muted, shortCwd(cwd)),
  ];
  if (opts.firstRun) {
    left.push("", paint(ansi.dim, "First-time setup next."));
  }

  const right: string[] = [
    paint(ansi.accentBright, "Tips for getting started"),
    paint(ansi.cmd, "/help") + paint(ansi.muted, "  see all commands"),
    paint(ansi.cmd, "/model") + paint(ansi.muted, " pin Qwen / Claude / GPT"),
    paint(ansi.cmd, "/mode") + paint(ansi.muted, "  auto | plan | build"),
    "",
    paint(ansi.accentBright, "Recent activity"),
    history.length === 0
      ? paint(ansi.muted, "No recent activity")
      : paint(ansi.muted, `${history.filter((m) => m.role === "user").length} turns in this session`),
  ];

  const rows = Math.max(left.length, right.length);
  const split = Math.floor(inner * 0.55);

  console.log(top);
  for (let i = 0; i < rows; i++) {
    const L = padLine(left[i] ?? "", split);
    const R = padLine(right[i] ?? "", inner - split - 1);
    console.log(`${edge()} ${L} ${R} ${edge()}`);
  }
  console.log(bot);
  console.log(paint(ansi.muted, ONE_LINER));
  console.log(paint(ansi.dim, "Type a task, or / for commands  ·  Tab to autocomplete"));
  console.log("");
}

function printSlashMenu(): void {
  console.log(paint(ansi.accentBright, "Commands"));
  for (const { cmd, help } of SLASH_COMMANDS) {
    console.log(`  ${paint(ansi.cmd, cmd.padEnd(14))} ${paint(ansi.muted, help)}`);
  }
}

function printWelcome(cwd: string): void {
  console.log(`${PRODUCT_NAME} (${SHORT_NAME})`);
  console.log(ONE_LINER);
  console.log("");
  console.log("First-time setup. This session stays open — ask follow-ups without restarting.");
  console.log(`Working directory: ${shortCwd(cwd)}`);
  console.log("");
}

async function runSetup(config: HarnesConfig, opts: { nested: boolean }): Promise<HarnesConfig> {
  const rl = readline.createInterface({ input, output, terminal: true });
  if (!opts.nested) printWelcome(process.cwd());
  console.log("How should Harnes talk to models?");
  console.log("  1) OpenRouter  (cloud, recommended — one key, many models)");
  console.log("  2) Ollama      (local, no cloud key)");
  console.log("  3) Skip        (configure later with /setup)\n");

  const choice = (await rl.question("Choose [1/2/3]: ")).trim() || "1";
  let next: HarnesConfig = { ...config, setupComplete: true };

  if (choice === "2") {
    next = {
      ...next,
      provider: "ollama",
      openaiCompatible: { baseUrl: OLLAMA_BASE_URL, apiKey: "ollama" },
    };
    console.log("Using Ollama at http://127.0.0.1:11434/v1");
  } else if (choice === "3") {
    console.log("Skipped. Run /setup when you have a key.");
  } else {
    const existing = process.env.OPENROUTER_API_KEY ?? config.openaiCompatible?.apiKey ?? "";
    const keepHint = existing.startsWith("sk-or-") ? "OpenRouter API key (Enter to keep): " : "OpenRouter API key (sk-or-...): ";
    const entered = (await rl.question(keepHint)).trim();
    const key = entered || (existing.startsWith("sk-or-") ? existing : "");
    if (!key) {
      console.log("No key stored. Run /setup later.");
    } else {
      next = {
        ...next,
        provider: "openrouter",
        openaiCompatible: { baseUrl: OPENROUTER_BASE_URL, apiKey: key },
      };
      console.log("OpenRouter saved to ~/.config/harnes/config.json");
    }
  }

  const modeIn = (await rl.question("Default session mode [auto/plan/build] (Enter=auto): ")).trim();
  next = { ...next, sessionMode: normalizeSessionMode(modeIn || "auto") };
  next.permissionMode = next.sessionMode === "plan" ? "plan" : "build";

  rl.close();
  await saveConfig(next);
  console.log("");
  return next;
}

async function handleSlash(
  text: string,
  ctx: {
    getConfig: () => HarnesConfig;
    setConfig: (config: HarnesConfig) => Promise<void>;
    history: ChatMessage[];
    usage: SessionUsage;
    cwd: string;
  }
): Promise<"ok" | "exit"> {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "exit":
    case "quit":
    case "q":
      return "exit";
    case "help":
    case "h":
      printSlashMenu();
      return "ok";
    case "clear":
      ctx.history.length = 0;
      ctx.usage.turns = 0;
      ctx.usage.agentSteps = 0;
      ctx.usage.toolCalls = 0;
      console.log(paint(ansi.muted, "Session cleared (context reset)."));
      return "ok";
    case "models":
      await listModels(ctx.getConfig());
      return "ok";
    case "model":
      await setModel(ctx, arg);
      return "ok";
    case "usage":
      printUsage(ctx.usage, ctx.getConfig(), ctx.history);
      return "ok";
    case "status": {
      printFullStatus(ctx.getConfig(), ctx.history, ctx.cwd, ctx.usage);
      return "ok";
    }
    case "mode": {
      if (arg && arg !== "auto" && arg !== "plan" && arg !== "build") {
        console.log("Usage: /mode auto|plan|build");
        return "ok";
      }
      if (!arg) {
        const session = resolveSession(ctx.getConfig(), ctx.history);
        console.log(`mode ${session.mode} (tools ${session.permissionMode})`);
        return "ok";
      }
      const sessionMode = arg as SessionMode;
      await ctx.setConfig({
        ...ctx.getConfig(),
        sessionMode,
        permissionMode: sessionMode === "plan" ? "plan" : "build",
      });
      const session = resolveSession(ctx.getConfig(), ctx.history);
      console.log(`mode ${session.mode} · tools ${session.permissionMode} · ${session.model.name}`);
      return "ok";
    }
    case "setup": {
      const next = await runSetup(ctx.getConfig(), { nested: true });
      await ctx.setConfig(next);
      printWelcomeBox(next, ctx.cwd, ctx.history, { firstRun: false });
      return "ok";
    }
    default:
      console.log(`Unknown command /${cmd}. Try /help.`);
      return "ok";
  }
}

async function listModels(config: HarnesConfig): Promise<void> {
  const session = resolveSession(config, []);
  const endpoint = resolveChatEndpoint(config);
  let models = MODEL_CATALOG;
  if (endpoint.provider === "openrouter") {
    try {
      models = await listOpenRouterModels({ apiKey: endpoint.apiKey });
    } catch {
      models = MODEL_CATALOG;
    }
  }
  console.log(`${"tier".padEnd(14)} ${"id".padEnd(40)} ctx`);
  for (const model of models.slice(0, 40)) {
    const mark = model.id === session.model.id || model.openrouterModel === session.wireId ? "*" : " ";
    const id = (model.openrouterModel ?? model.id).slice(0, 40);
    console.log(`${model.tier.padEnd(14)} ${id.padEnd(40)} ${String(model.minContext).padStart(8)} ${mark}`);
  }
  if (models.length > 40) console.log(`… ${models.length - 40} more (pin with /model <id>)`);
  console.log("Pin with /model <id>   ·   /model auto");
}

async function setModel(
  ctx: {
    getConfig: () => HarnesConfig;
    setConfig: (config: HarnesConfig) => Promise<void>;
    history: ChatMessage[];
  },
  arg: string
): Promise<void> {
  if (!arg) {
    const session = resolveSession(ctx.getConfig(), ctx.history);
    console.log(
      session.routing === "pinned"
        ? `pinned ${session.model.id} (${session.model.name}) · ctx ${session.contextWindow.toLocaleString()}`
        : `auto-route → ${session.model.id} (${session.model.name})`
    );
    return;
  }
  if (arg === "auto") {
    const next = { ...ctx.getConfig() };
    delete next.pinnedModelId;
    await ctx.setConfig(next);
    console.log("Model routing: auto");
    return;
  }
  try {
    // Warm the live catalog so OpenRouter slugs resolve when pinning.
    const endpoint = resolveChatEndpoint(ctx.getConfig());
    if (endpoint.provider === "openrouter") {
      try {
        await listOpenRouterModels({ apiKey: endpoint.apiKey });
      } catch {
        /* curated fallback is enough */
      }
    }
    const model = getModel(normalizeModelId(arg));
    const pinId = model.openrouterModel ?? model.id;
    await ctx.setConfig({ ...ctx.getConfig(), pinnedModelId: pinId });
    console.log(`Pinned ${model.name} (${pinId}) · ctx ${model.minContext.toLocaleString()}`);
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
  }
}

async function runTurn(
  prompt: string,
  config: HarnesConfig,
  backend: LocalBackend,
  history: ChatMessage[],
  usage: SessionUsage
): Promise<void> {
  if (!hasUsableApiKey(config) && config.provider !== "ollama") {
    console.log("No API key configured. Run /setup first.");
    return;
  }

  console.log(paint(ansi.warm, "Running…"));

  const session = resolveSession(config, history, prompt);
  const endpoint = resolveChatEndpoint(config);

  const result = await runAgentLoop({
    prompt,
    model: { ...session.model, providerModel: session.wireId },
    backend,
    permissionMode: session.permissionMode,
    history,
    complete: (input) => openaiCompatibleComplete(endpoint.baseUrl, endpoint.apiKey, input),
  });

  usage.turns += 1;
  usage.agentSteps += result.steps;
  usage.toolCalls += result.messages.filter((message) => message.role === "tool").length;

  history.length = 0;
  history.push(...result.messages.filter((message) => message.role !== "system"));

  const last = [...result.messages].reverse().find((message) => message.role === "assistant" && message.content);
  console.log("");
  if (last?.content) console.log(last.content);
  else console.log(paint(ansi.muted, `(${result.stoppedReason} after ${result.steps} steps)`));
}

function printUsage(usage: SessionUsage, config: HarnesConfig, history: ChatMessage[]): void {
  const session = resolveSession(config, history);
  console.log(
    `session  turns=${usage.turns}  steps=${usage.agentSteps}  tool_calls=${usage.toolCalls}  ctx ${formatTokenBar(session.tokensUsed, session.contextWindow)}`
  );
}

function printFullStatus(config: HarnesConfig, history: ChatMessage[], cwd: string, usage: SessionUsage): void {
  const session = resolveSession(config, history);
  const endpoint = resolveChatEndpoint(config);
  console.log(`provider   ${endpoint.provider}`);
  console.log(`baseUrl    ${endpoint.baseUrl}`);
  console.log(`key        ${maskKey(endpoint.apiKey)}`);
  console.log(`model      ${session.model.name} (${session.wireId}) [${session.routing}]`);
  console.log(`mode       ${session.mode} · tools ${session.permissionMode}`);
  console.log(`context    ${formatTokenBar(session.tokensUsed, session.contextWindow)}`);
  console.log(`cwd        ${shortCwd(cwd)}`);
  console.log(`history    ${history.length} messages`);
  console.log(`usage      turns=${usage.turns} tools=${usage.toolCalls}`);
}

function maskKey(key: string | undefined): string {
  if (!key) return "(none)";
  if (key === "ollama") return "ollama";
  if (key.length < 12) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
