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
import {
  needsApproval,
  permissionForSessionMode,
  SESSION_MODE_LABELS,
  SESSION_MODES,
} from "./exec/types.ts";
import {
  openaiCompatibleComplete,
  runAgentLoop,
  type ChatMessage,
  type LoopProgress,
  type ToolCall,
} from "./loop.ts";
import {
  getModel,
  listOpenRouterModels,
  MODEL_CATALOG,
  OPENROUTER_BASE_URL,
  OLLAMA_BASE_URL,
  normalizeModelId,
} from "./models/catalog.ts";
import { ONE_LINER, PRODUCT_NAME, SHORT_NAME } from "./positioning.ts";
import { fetchOpenRouterKeyUsage, formatUsd } from "./openrouter/usage.ts";
import {
  cycleSessionMode,
  formatFooterLines,
  formatTokenBar,
  normalizeSessionMode,
  resolveSession,
  type SessionUsage,
} from "./session.ts";
import { applyUpdate, checkForUpdate, NPM_PACKAGE } from "./update.ts";

export type { SessionUsage };

function emptySessionUsage(): SessionUsage {
  return {
    turns: 0,
    agentSteps: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
  };
}

/** Animated status line that rewrites in place so long turns don't look stuck. */
function startStatusLine(initial = "Running"): { update: (text: string) => void; stop: (final?: string) => void } {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let label = initial;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const frame = frames[i % frames.length];
    i += 1;
    output.write(`\r${paint(ansi.warm, `${frame} ${label}…`)}${" ".repeat(12)}`);
  };
  tick();
  const id = setInterval(tick, 80);
  return {
    update(text: string) {
      label = text;
    },
    stop(final?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(id);
      output.write(`\r\x1b[2K`);
      if (final) console.log(paint(ansi.soft, final));
    },
  };
}

const VERSION = "0.2.0";
const FOOTER_ROWS = 3; // separator + 2 status lines

const SLASH_COMMANDS: Array<{ cmd: string; help: string }> = [
  { cmd: "/help", help: "show commands" },
  { cmd: "/setup", help: "configure OpenRouter or Ollama" },
  { cmd: "/status", help: "model, mode, context, cwd" },
  { cmd: "/model", help: "show / pin active model" },
  { cmd: "/model auto", help: "route per prompt" },
  { cmd: "/models", help: "list catalog" },
  { cmd: "/mode", help: "auto | manual | ask | plan  (⇧Tab)" },
  { cmd: "/usage", help: "session + OpenRouter spend" },
  { cmd: "/cost", help: "alias for /usage" },
  { cmd: "/update", help: "check / install latest from npm" },
  { cmd: "/update auto on", help: "opt-in: auto-install on startup" },
  { cmd: "/clear", help: "reset conversation memory" },
  { cmd: "/exit", help: "quit" },
];

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  accent: "\x1b[38;5;246m",
  accentBright: "\x1b[38;5;252m",
  muted: "\x1b[38;5;243m",
  cmd: "\x1b[38;5;147m",
  soft: "\x1b[38;5;150m",
  warm: "\x1b[38;5;215m",
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

type TtyKey = { name?: string; shift?: boolean; ctrl?: boolean; meta?: boolean };

type RlWithTty = readline.Interface & {
  _ttyWrite?: (s: string | undefined, key: TtyKey) => void;
  line?: string;
  cursor?: number;
};

export async function startRepl(initialConfig: HarnesConfig): Promise<void> {
  let config = initialConfig;
  const cwd = process.cwd();
  const backend = new LocalBackend(cwd);
  const history: ChatMessage[] = [];
  const usage: SessionUsage = emptySessionUsage();

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

  config = await maybeHandleUpdateOnStart(config);

  printWelcomeBox(config, cwd, history, { firstRun: false });

  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
    completer: slashCompleter,
  }) as RlWithTty;

  const showIdle = () => {
    const session = resolveSession(config, history);
    const width = Math.min(process.stdout.columns || 80, 88);
    const [line1, line2] = formatFooterLines(session, usage.costUsd);
    const plainPrompt = " › ";
    const lineLen = (rl.line ?? "").length;
    rl.setPrompt(promptPrefix());
    output.write(ansi.reset);
    output.write("\r\x1b[0K");
    rl.prompt();
    if (rl.line) output.write(rl.line);
    output.write(
      `\n${paint(ansi.dim, "─".repeat(width))}\n` +
        `${paint(ansi.soft, line1)}\n` +
        `${paint(ansi.warm, line2)}`
    );
    // Return to the input line; caret after prompt + typed text.
    output.write(`\x1b[${FOOTER_ROWS}A\x1b[${plainPrompt.length + 1 + lineLen}G`);
  };

  const clearBelowInput = () => {
    output.write(`${ansi.reset}\r\x1b[0J\n`);
  };

  const cycleModeFromKey = async () => {
    const nextMode = cycleSessionMode(normalizeSessionMode(config.sessionMode));
    config = {
      ...config,
      sessionMode: nextMode,
      permissionMode: permissionForSessionMode(nextMode),
    };
    await saveConfig(config);
    // Redraw footer in place without dumping completer noise.
    output.write("\x1b[0J");
    showIdle();
    // Toast on the status line briefly via stderr-adjacent write above footer
    output.write(`\x1b[s\x1b[${FOOTER_ROWS}B\r\x1b[2K${paint(ansi.soft, `mode → ${SESSION_MODE_LABELS[nextMode]}`)}\x1b[u`);
  };

  // Shift+Tab must NOT run readline reverse-tab completion (that stacked the / menu).
  const originalTtyWrite = rl._ttyWrite?.bind(rl);
  if (originalTtyWrite) {
    rl._ttyWrite = (s, key) => {
      if (key?.name === "tab" && key.shift) {
        void cycleModeFromKey();
        return;
      }
      return originalTtyWrite(s, key);
    };
  }

  const shutdown = async () => {
    output.write(ansi.reset);
    rl.close();
    await backend.close();
    await printUsage(usage, config, history);
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
        rl,
      });
      if (done === "exit") break;
      showIdle();
      continue;
    }

    try {
      await runTurn(text, config, backend, history, usage, rl);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    showIdle();
  }

  await shutdown();
}

/** Only complete slash commands; never dump the full menu on bare Tab / reverse-Tab. */
function slashCompleter(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const hits = SLASH_COMMANDS.map((c) => c.cmd).filter((c) => c.startsWith(line));
  return [hits, line];
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
    paint(ansi.muted, `${session.model.name} · ${session.modeLabel}`),
    paint(ansi.muted, shortCwd(cwd)),
  ];
  if (opts.firstRun) {
    left.push("", paint(ansi.dim, "First-time setup next."));
  }

  const right: string[] = [
    paint(ansi.accentBright, "Tips for getting started"),
    paint(ansi.cmd, "/help") + paint(ansi.muted, "  see all commands"),
    paint(ansi.cmd, "/model") + paint(ansi.muted, " pin Qwen / Claude / GPT"),
    paint(ansi.cmd, "/mode") + paint(ansi.muted, "  ⇧Tab cycle approvals"),
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
  console.log(
    paint(ansi.dim, "Type a task, or / for commands  ·  Tab autocomplete  ·  ⇧Tab cycle mode")
  );
  console.log("");
}

function printSlashMenu(): void {
  console.log(paint(ansi.accentBright, "Commands"));
  for (const { cmd, help } of SLASH_COMMANDS) {
    console.log(`  ${paint(ansi.cmd, cmd.padEnd(18))} ${paint(ansi.muted, help)}`);
  }
  console.log("");
  console.log(paint(ansi.muted, "Modes (⇧Tab): automatic → manual → ask on edit → plan"));
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
    const keepHint = existing.startsWith("sk-or-")
      ? "OpenRouter API key (Enter to keep): "
      : "OpenRouter API key (sk-or-...): ";
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

  const modeIn = (
    await rl.question("Default mode [auto/manual/ask/plan] (Enter=ask): ")
  ).trim();
  const sessionMode = normalizeSessionMode(modeIn || "ask");
  next = {
    ...next,
    sessionMode,
    permissionMode: permissionForSessionMode(sessionMode),
  };

  rl.close();
  await saveConfig(next);
  console.log("");
  return next;
}

async function maybeHandleUpdateOnStart(config: HarnesConfig): Promise<HarnesConfig> {
  try {
    const check = await checkForUpdate(VERSION);
    if (!check.updateAvailable) return config;

    if (config.autoUpdate) {
      console.log(
        paint(ansi.warm, `Auto-update: ${check.current} → ${check.latest} (${NPM_PACKAGE})…`)
      );
      const result = await applyUpdate();
      if (result.ok) {
        console.log(paint(ansi.soft, `Updated to ${check.latest}. Restart Harnes to load it.`));
      } else {
        console.log(paint(ansi.muted, `Auto-update failed: ${result.output.slice(0, 200)}`));
        console.log(paint(ansi.muted, `Run /update or: npm install -g ${NPM_PACKAGE}`));
      }
      console.log("");
      return config;
    }

    console.log(
      paint(
        ansi.warm,
        `Update available: ${check.current} → ${check.latest}  ·  /update  ·  /update auto on`
      )
    );
    console.log("");
  } catch {
    /* offline / registry blip — ignore */
  }
  return config;
}

async function handleSlash(
  text: string,
  ctx: {
    getConfig: () => HarnesConfig;
    setConfig: (config: HarnesConfig) => Promise<void>;
    history: ChatMessage[];
    usage: SessionUsage;
    cwd: string;
    rl: readline.Interface;
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
      Object.assign(ctx.usage, emptySessionUsage());
      console.log(paint(ansi.muted, "Session cleared (context + session cost reset)."));
      return "ok";
    case "models":
      await listModels(ctx.getConfig());
      return "ok";
    case "model":
      await setModel(ctx, arg);
      return "ok";
    case "usage":
    case "cost":
      await printUsage(ctx.usage, ctx.getConfig(), ctx.history);
      return "ok";
    case "status": {
      printFullStatus(ctx.getConfig(), ctx.history, ctx.cwd, ctx.usage);
      return "ok";
    }
    case "update":
      await handleUpdateCommand(ctx, arg);
      return "ok";
    case "mode": {
      if (!arg) {
        const session = resolveSession(ctx.getConfig(), ctx.history);
        console.log(`mode ${session.modeLabel} (${session.mode}) · tools ${session.permissionMode}`);
        console.log(paint(ansi.muted, `cycle: ${SESSION_MODES.map((m) => SESSION_MODE_LABELS[m]).join(" → ")}`));
        return "ok";
      }
      const aliases = new Set(["auto", "automatic", "manual", "ask", "ask-on-edit", "plan", "build"]);
      if (!aliases.has(arg.toLowerCase())) {
        console.log("Usage: /mode auto|manual|ask|plan   (or ⇧Tab)");
        return "ok";
      }
      const sessionMode = normalizeSessionMode(arg);
      await ctx.setConfig({
        ...ctx.getConfig(),
        sessionMode,
        permissionMode: permissionForSessionMode(sessionMode),
      });
      const session = resolveSession(ctx.getConfig(), ctx.history);
      console.log(`mode ${session.modeLabel} · tools ${session.permissionMode} · ${session.model.name}`);
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

async function handleUpdateCommand(
  ctx: {
    getConfig: () => HarnesConfig;
    setConfig: (config: HarnesConfig) => Promise<void>;
  },
  arg: string
): Promise<void> {
  const parts = arg.split(/\s+/).filter(Boolean);
  if (parts[0] === "auto") {
    const on = parts[1] === "on" || parts[1] === "true" || parts[1] === "1";
    const off = parts[1] === "off" || parts[1] === "false" || parts[1] === "0";
    if (!on && !off) {
      console.log(`auto-update is ${ctx.getConfig().autoUpdate ? "on" : "off"}  ·  /update auto on|off`);
      return;
    }
    await ctx.setConfig({ ...ctx.getConfig(), autoUpdate: on });
    console.log(on ? "Auto-update enabled (installs on startup when newer)." : "Auto-update disabled (notify only).");
    return;
  }

  try {
    const check = await checkForUpdate(VERSION, { force: true });
    if (!check.updateAvailable) {
      console.log(`Up to date (${check.current}).`);
      return;
    }
    console.log(`Installing ${check.current} → ${check.latest}…`);
    const result = await applyUpdate();
    if (result.ok) {
      console.log(paint(ansi.soft, `Installed ${check.latest}. Restart Harnes (quit + reopen) to load it.`));
    } else {
      console.log(paint(ansi.muted, result.output.slice(0, 400) || "npm install failed"));
      console.log(`Try: npm install -g ${NPM_PACKAGE}`);
    }
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
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
    const endpoint = resolveChatEndpoint(ctx.getConfig());
    if (endpoint.provider === "openrouter") {
      try {
        await listOpenRouterModels({ apiKey: endpoint.apiKey });
      } catch {
        /* curated fallback */
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

function summarizeTool(call: ToolCall): string {
  if (call.name === "write_file") return `write_file ${call.arguments.path ?? ""}`;
  if (call.name === "bash") {
    const cmd = call.arguments.command ?? "";
    return `bash ${cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd}`;
  }
  if (call.name === "read_file") return `read_file ${call.arguments.path ?? ""}`;
  return `${call.name} ${JSON.stringify(call.arguments).slice(0, 60)}`;
}

async function runTurn(
  prompt: string,
  config: HarnesConfig,
  backend: LocalBackend,
  history: ChatMessage[],
  usage: SessionUsage,
  rl: readline.Interface
): Promise<void> {
  if (!hasUsableApiKey(config) && config.provider !== "ollama") {
    console.log("No API key configured. Run /setup first.");
    return;
  }

  const started = Date.now();
  let status = startStatusLine("Running");
  const session = resolveSession(config, history, prompt);
  const endpoint = resolveChatEndpoint(config);
  const mode = session.mode;

  try {
    const result = await runAgentLoop({
      prompt,
      model: { ...session.model, providerModel: session.wireId },
      backend,
      permissionMode: session.permissionMode,
      history,
      complete: (input) => openaiCompatibleComplete(endpoint.baseUrl, endpoint.apiKey, input),
      onProgress: (event: LoopProgress) => {
        if (event.type === "thinking") status.update(`Thinking · step ${event.step}`);
        else status.update(`${event.name} · step ${event.step}`);
      },
      onApprove: async (call) => {
        if (!needsApproval(mode, call.name)) return true;
        status.stop();
        const answer = (await rl.question(paint(ansi.warm, `Allow ${summarizeTool(call)}? [y/N] `)))
          .trim()
          .toLowerCase();
        const ok = answer === "y" || answer === "yes";
        status = startStatusLine(ok ? call.name : "Running");
        return ok;
      },
    });

    usage.turns += 1;
    usage.agentSteps += result.steps;
    usage.toolCalls += result.messages.filter((message) => message.role === "tool").length;
    usage.promptTokens += result.usage.promptTokens;
    usage.completionTokens += result.usage.completionTokens;
    usage.costUsd += result.usage.costUsd ?? 0;

    history.length = 0;
    history.push(...result.messages.filter((message) => message.role !== "system"));

    const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
    const turnCost = result.usage.costUsd ?? 0;
    const costPart =
      endpoint.provider === "openrouter" || turnCost > 0
        ? ` · ${formatUsd(turnCost)} this turn · ${formatUsd(usage.costUsd)} session`
        : "";
    status.stop(
      `✓ Done · ${elapsedSec}s · ${result.steps} step${result.steps === 1 ? "" : "s"} · ${result.stoppedReason}${costPart}`
    );

    const last = [...result.messages].reverse().find((message) => message.role === "assistant" && message.content);
    console.log("");
    if (last?.content) console.log(last.content);
    else console.log(paint(ansi.muted, `(${result.stoppedReason} after ${result.steps} steps)`));
  } catch (error) {
    status.stop();
    throw error;
  }
}

async function printUsage(usage: SessionUsage, config: HarnesConfig, history: ChatMessage[]): Promise<void> {
  const session = resolveSession(config, history);
  const endpoint = resolveChatEndpoint(config);
  console.log(paint(ansi.accentBright, "This session"));
  console.log(
    `  turns ${usage.turns}  ·  steps ${usage.agentSteps}  ·  tools ${usage.toolCalls}  ·  ctx ${formatTokenBar(session.tokensUsed, session.contextWindow)}`
  );
  console.log(
    `  tokens in ${usage.promptTokens.toLocaleString()} / out ${usage.completionTokens.toLocaleString()}  ·  spend ${formatUsd(usage.costUsd)}`
  );

  if (endpoint.provider === "openrouter" && endpoint.apiKey) {
    console.log("");
    console.log(paint(ansi.accentBright, "OpenRouter (this API key)"));
    try {
      const key = await fetchOpenRouterKeyUsage(endpoint.apiKey);
      console.log(`  today     ${formatUsd(key.usageDaily)}`);
      console.log(`  week      ${formatUsd(key.usageWeekly)}`);
      console.log(`  month     ${formatUsd(key.usageMonthly)}  (≈ last 30 days on this key)`);
      console.log(`  lifetime  ${formatUsd(key.usage)}`);
      if (key.limit != null) {
        console.log(
          `  limit     ${formatUsd(key.limitRemaining ?? 0)} left of ${formatUsd(key.limit)}${key.limitReset ? ` · resets ${key.limitReset}` : ""}`
        );
      }
    } catch (error) {
      console.log(paint(ansi.muted, `  (could not fetch /key: ${error instanceof Error ? error.message : error})`));
    }
  } else {
    console.log("");
    console.log(paint(ansi.muted, "OpenRouter spend breakdown needs provider=openrouter."));
  }
}

function printFullStatus(config: HarnesConfig, history: ChatMessage[], cwd: string, usage: SessionUsage): void {
  const session = resolveSession(config, history);
  const endpoint = resolveChatEndpoint(config);
  console.log(`provider   ${endpoint.provider}`);
  console.log(`baseUrl    ${endpoint.baseUrl}`);
  console.log(`key        ${maskKey(endpoint.apiKey)}`);
  console.log(`model      ${session.model.name} (${session.wireId}) [${session.routing}]`);
  console.log(`mode       ${session.modeLabel} (${session.mode}) · tools ${session.permissionMode}`);
  console.log(`autoUpdate ${config.autoUpdate ? "on" : "off"}`);
  console.log(`context    ${formatTokenBar(session.tokensUsed, session.contextWindow)}`);
  console.log(`cwd        ${shortCwd(cwd)}`);
  console.log(`history    ${history.length} messages`);
  console.log(`usage      turns=${usage.turns} tools=${usage.toolCalls} spend=${formatUsd(usage.costUsd)}`);
  console.log(`version    ${VERSION}`);
}

function maskKey(key: string | undefined): string {
  if (!key) return "(none)";
  if (key === "ollama") return "ollama";
  if (key.length < 12) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
