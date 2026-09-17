import * as os from "node:os";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  configFromEnv,
  hasUsableApiKey,
  resolveChatEndpoint,
  saveConfig,
  type HarnesConfig,
} from "./config.ts";
import { LocalBackend } from "./exec/local.ts";
import {
  MCP_TOOL_PREFIX,
  needsApproval,
  permissionForSessionMode,
  SESSION_MODE_LABELS,
  SESSION_MODES,
} from "./exec/types.ts";
import {
  CONTINUE_NUDGE,
  openaiCompatibleComplete,
  runAgentLoop,
  shouldAutoContinue,
  type ChatMessage,
  type LoopProgress,
  type ToolCall,
} from "./loop.ts";
import { McpManager } from "./mcp/manager.ts";
import { formatSkillList, listSkills } from "./skills.ts";
import { formatTodoList, type TodoItem } from "./todos.ts";
import {
  getModel,
  listOpenRouterModels,
  MODEL_CATALOG,
  OPENROUTER_BASE_URL,
  OLLAMA_BASE_URL,
  normalizeModelId,
  type ModelSpec,
} from "./models/catalog.ts";
import { ONE_LINER, PRODUCT_NAME, SHORT_NAME } from "./positioning.ts";
import { fetchOpenRouterKeyUsage, formatUsd } from "./openrouter/usage.ts";
import {
  cycleSessionMode,
  formatFooterChrome,
  formatTokenBar,
  gitBranch,
  normalizeSessionMode,
  resolveSession,
  type SessionUsage,
} from "./session.ts";
import { applyUpdate, checkForUpdate, NPM_PACKAGE } from "./update.ts";
import { selectFromList, type SelectItem } from "./ui/select.ts";
import { HARNES_VERSION } from "./version.ts";

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
function startStatusLine(initial = "Running"): {
  update: (text: string) => void;
  /** Print a durable trail line above the spinner (tools / narration). */
  note: (line: string) => void;
  stop: (final?: string) => void;
} {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const started = Date.now();
  let i = 0;
  let label = initial;
  let stopped = false;
  const render = () => {
    if (stopped) return;
    const frame = frames[i % frames.length];
    i += 1;
    const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const text = `${frame} ${label} · ${elapsed}s`;
    // Pad then clear to EOL so shorter labels don't leave leftovers.
    output.write(`\r${paint(ansi.warm, text)}\x1b[K`);
  };
  render();
  const id = setInterval(render, 80);
  return {
    update(text: string) {
      label = text;
    },
    note(line: string) {
      if (stopped) {
        console.log(line);
        return;
      }
      output.write(`\r\x1b[2K`);
      console.log(line);
      render();
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

const VERSION = HARNES_VERSION;
const FOOTER_ROWS = 3; // full-width rule + status + bottom bar

const SLASH_COMMANDS: Array<{ cmd: string; help: string }> = [
  { cmd: "/help", help: "show commands (/h)" },
  { cmd: "/setup", help: "configure OpenRouter or Ollama" },
  { cmd: "/status", help: "model, mode, context, cwd" },
  { cmd: "/todos", help: "show the current task list" },
  { cmd: "/mcp", help: "list configured MCP servers/tools/status" },
  { cmd: "/skills", help: "list available skill files" },
  { cmd: "/model", help: "pick a model (↑↓/click · Enter) · /model <id> · /model auto" },
  { cmd: "/models", help: "same as /model — interactive catalog picker" },
  { cmd: "/mode", help: "auto | manual | ask | plan  (labels: automatic / ask on edit)  ⌃T / ⇧Tab" },
  { cmd: "/usage", help: "session + OpenRouter spend" },
  { cmd: "/cost", help: "alias for /usage" },
  { cmd: "/update", help: "check / install latest from npm (/update auto on|off)" },
  { cmd: "/clear", help: "reset conversation memory" },
  { cmd: "/exit", help: "quit (aliases: /quit, /q)" },
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

type TtyKey = {
  name?: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
};

type RlWithTty = readline.Interface & {
  _ttyWrite?: (s: string | undefined, key: TtyKey) => void;
  line?: string;
  cursor?: number;
};

/** Warp often remaps Shift+Tab → Ctrl+Y; also accept Ctrl+T as a reliable cycle key. */
function isModeCycleKey(key: TtyKey | undefined): boolean {
  if (!key) return false;
  if (key.name === "tab" && key.shift) return true;
  if (key.sequence === "\x1b[Z") return true;
  if (key.ctrl && (key.name === "y" || key.name === "t")) return true;
  return false;
}

export async function startRepl(initialConfig: HarnesConfig): Promise<void> {
  let config = initialConfig;
  const cwd = process.cwd();
  const backend = new LocalBackend(cwd);
  let mcp = new McpManager(config.mcpServers ?? {});
  const history: ChatMessage[] = [];
  const todos: TodoItem[] = [];
  const usage: SessionUsage = emptySessionUsage();
  let lastDone = "";
  let turnBusy = false;
  let slashBusy = false;
  let painting = false;
  let turnAbort: AbortController | undefined;

  const replaceMcp = async (nextConfig: HarnesConfig) => {
    const prev = JSON.stringify(config.mcpServers ?? {});
    const next = JSON.stringify(nextConfig.mcpServers ?? {});
    if (prev === next) return;
    await mcp.close();
    mcp = new McpManager(nextConfig.mcpServers ?? {});
  };

  if (!process.stdin.isTTY) {
    console.error("Persistent session needs a TTY. Use `harnes run \"...\"` for one-shot.");
    await backend.close();
    process.exitCode = 1;
    return;
  }

  const envKey = openRouterKeyFromEnv();
  // Env already has a usable OpenRouter key → skip the interactive wizard entirely.
  const firstRunNeedsWizard = !config.setupComplete || !hasUsableApiKey(config);
  if (firstRunNeedsWizard && envKey && !config.setupComplete) {
    const saved: HarnesConfig = {
      ...config,
      setupComplete: true,
      provider: "openrouter",
      openaiCompatible: { baseUrl: OPENROUTER_BASE_URL },
      sessionMode: config.sessionMode || "ask",
      permissionMode: permissionForSessionMode(config.sessionMode || "ask"),
    };
    await saveConfig(saved);
    config = configFromEnv(saved);
    console.log(paint(ansi.soft, "Using OPENROUTER_API_KEY from the environment."));
    console.log("");
  } else if (firstRunNeedsWizard) {
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

  const footerBlock = (): string => {
    const session = resolveSession(config, history);
    const width = process.stdout.columns || 80;
    const chrome = formatFooterChrome({
      session,
      cwd,
      width,
      costUsd: usage.costUsd,
      lastDone: lastDone || undefined,
    });
    const chip = (label: string) => `${ansi.inputBg}${ansi.inputFg} ${label} ${ansi.reset}`;
    const branch = gitBranch(cwd);
    const chips = [
      chip("◆"),
      chip(session.modeLabel),
      chip(shortCwd(cwd)),
      ...(branch ? [chip(branch)] : []),
    ].join(" ");
    const barRight = session.routing === "pinned" ? "pinned" : "/mode";
    const gap = Math.max(1, width - visibleWidth(chips) - barRight.length);
    const bar = `${chips}${" ".repeat(gap)}${paint(ansi.muted, barRight)}`;
    return `${paint(ansi.dim, chrome.separator)}\n${paint(ansi.muted, chrome.status)}\n${bar}`;
  };

  /** Keep the status strip under the input while typing (readline otherwise wipes it). */
  const paintFooterUnderInput = () => {
    if (turnBusy || painting || slashBusy) return;
    painting = true;
    try {
      const plainPrompt = " › ";
      const line = rl.line ?? "";
      const width = Math.max(20, process.stdout.columns || 80);
      const inputRows = Math.max(1, Math.ceil((plainPrompt.length + Math.max(line.length, 1)) / width));
      const cursor = rl.cursor ?? line.length;
      const absCol = plainPrompt.length + cursor;
      const rowInInput = Math.floor(absCol / width);
      const col = (absCol % width) + 1;
      // Clear below prompt, paint footer, then move cursor back onto the input row.
      output.write(`\n\x1b[0J${footerBlock()}`);
      const up = FOOTER_ROWS + (inputRows - 1 - rowInInput);
      output.write(`\x1b[${up}A\x1b[${col}G`);
    } finally {
      painting = false;
    }
  };

  const showIdle = () => {
    turnBusy = false;
    const line = rl.line ?? "";
    rl.setPrompt(promptPrefix());
    output.write(ansi.reset);
    output.write("\r\x1b[0K");
    rl.prompt();
    if (line) output.write(line);
    paintFooterUnderInput();
  };

  const clearBelowInput = () => {
    output.write(`${ansi.reset}\r\x1b[0J\n`);
  };

  const cycleModeFromKey = async () => {
    if (turnBusy) return;
    const nextMode = cycleSessionMode(normalizeSessionMode(config.sessionMode));
    config = {
      ...config,
      sessionMode: nextMode,
      permissionMode: permissionForSessionMode(nextMode),
    };
    await saveConfig(config);
    paintFooterUnderInput();
  };

  const originalTtyWrite = rl._ttyWrite?.bind(rl);
  if (originalTtyWrite) {
    rl._ttyWrite = (s, key) => {
      if (isModeCycleKey(key)) {
        void cycleModeFromKey();
        return;
      }
      originalTtyWrite(s, key);
      // Re-anchor footer after every edit so it stays visible while typing.
      if (!turnBusy && key?.name !== "return" && key?.name !== "enter") {
        paintFooterUnderInput();
      }
    };
  }

  const shutdown = async () => {
    turnBusy = true;
    output.write(ansi.reset);
    clearBelowInput();
    rl.close();
    await backend.close();
    await mcp.close();
    await printUsage(usage, config, history);
  };

  rl.on("SIGINT", () => {
    if (slashBusy) {
      clearBelowInput();
      output.write(`${paint(ansi.muted, "(finish /setup or press Enter — Ctrl+C ignored during slash wizards)")}\n`);
      return;
    }
    if (turnBusy && turnAbort && !turnAbort.signal.aborted) {
      turnAbort.abort();
      clearBelowInput();
      output.write(`${paint(ansi.muted, "(interrupted — stopping this turn…)")}\n`);
      return;
    }
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
      slashBusy = true;
      try {
        const done = await handleSlash(text, {
          getConfig: () => config,
          setConfig: async (next) => {
            await replaceMcp(next);
            config = next;
            await saveConfig(config);
          },
          history,
          todos,
          usage,
          cwd,
          rl,
          getMcp: () => mcp,
        });
        if (done === "exit") break;
      } finally {
        slashBusy = false;
      }
      showIdle();
      continue;
    }

    try {
      turnBusy = true;
      turnAbort = new AbortController();
      lastDone = await runTurn(text, config, backend, mcp, history, todos, usage, rl, cwd, turnAbort.signal);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      lastDone = "error";
    } finally {
      turnAbort = undefined;
    }
    showIdle();
  }

  await shutdown();
}

/** Only complete slash commands; never dump the full menu on bare Tab / reverse-Tab. */
function slashCompleter(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  // Complete the first token only (e.g. "/mo" → "/mode", "/model")
  const space = line.indexOf(" ");
  if (space !== -1) {
    const cmd = line.slice(0, space);
    const rest = line.slice(space + 1);
    if (cmd === "/mode" || cmd === "/model") {
      const modeHits = ["auto", "manual", "ask", "plan"].filter((m) => m.startsWith(rest));
      if (cmd === "/mode" && modeHits.length) return [modeHits.map((m) => `${cmd} ${m}`), line];
      if (cmd === "/model") {
        const modelHits = ["auto", ...MODEL_CATALOG.map((m) => m.id)].filter((m) => m.startsWith(rest));
        if (modelHits.length) return [modelHits.map((m) => `${cmd} ${m}`), line];
      }
    }
    return [[], line];
  }
  const hits = SLASH_COMMANDS.map((c) => c.cmd).filter((c) => c.startsWith(line) && !c.includes(" ", 1));
  // Prefer unique base commands over "/model auto" style duplicates when completing "/m"
  const bases = [...new Set(hits.map((h) => h.split(" ")[0]))];
  return [bases.length ? bases : hits, line];
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
    paint(ansi.cmd, "/model") + paint(ansi.muted, " pick Qwen / Claude / GPT"),
    paint(ansi.cmd, "/mode") + paint(ansi.muted, "  ⌃T / ⇧Tab cycle modes"),
    "",
    paint(ansi.accentBright, "This session"),
    history.length === 0
      ? paint(ansi.muted, "Fresh start — type a task")
      : paint(ansi.muted, `${history.filter((m) => m.role === "user").length} user turns so far`),
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
    paint(ansi.dim, "Type a task, or / for commands  ·  Tab autocomplete  ·  ⌃T cycle mode (⇧Tab in iTerm)")
  );
  console.log("");
}

function printSlashMenu(): void {
  console.log(paint(ansi.accentBright, "Commands"));
  for (const { cmd, help } of SLASH_COMMANDS) {
    console.log(`  ${paint(ansi.cmd, cmd.padEnd(18))} ${paint(ansi.muted, help)}`);
  }
  console.log("");
  console.log(paint(ansi.muted, "Modes (⌃T or ⇧Tab): automatic → manual → ask on edit → plan"));
  console.log(paint(ansi.muted, "Warp tip: Shift+Tab is often broken — use Ctrl+T to cycle."));
  console.log(
    paint(
      ansi.muted,
      "Agent tools: edit_file (patch-style edits), ranged read_file, git_status/diff/log/commit, run_tests, todo_write — see /todos. delegate spawns a capped, isolated subagent for bounded work. External MCP servers (see /mcp) add more tools, namespaced mcp__<server>__<tool>. skill loads a markdown file from .harnes/skills/ — see /skills and docs/skills.md."
    )
  );
}

function printWelcome(cwd: string): void {
  console.log(`${PRODUCT_NAME} (${SHORT_NAME})`);
  console.log(ONE_LINER);
  console.log("");
  console.log("First-time setup. This session stays open — ask follow-ups without restarting.");
  console.log(`Working directory: ${shortCwd(cwd)}`);
  console.log("");
}

function openRouterKeyFromEnv(): string {
  const key = (process.env.OPENROUTER_API_KEY ?? process.env.HARNES_OPENROUTER_API_KEY ?? "").trim();
  return key.startsWith("sk-or-") ? key : "";
}

async function runSetup(
  config: HarnesConfig,
  opts: { nested: boolean; rl?: readline.Interface }
): Promise<HarnesConfig> {
  const ownsRl = !opts.rl;
  const rl = opts.rl ?? readline.createInterface({ input, output, terminal: true });
  if (!opts.nested) printWelcome(process.cwd());

  const envKey = openRouterKeyFromEnv();
  if (envKey) {
    console.log(paint(ansi.soft, "OPENROUTER_API_KEY detected in the environment — will use it for OpenRouter."));
    console.log("");
  }

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
  } else if (envKey) {
    // Env already has a usable key — never re-prompt, and don't copy the secret into config.json.
    next = {
      ...next,
      provider: "openrouter",
      openaiCompatible: { baseUrl: OPENROUTER_BASE_URL },
    };
    console.log("OpenRouter ready (using OPENROUTER_API_KEY from the environment).");
  } else {
    const stored = (config.openaiCompatible?.apiKey ?? "").trim();
    const keepable = stored.startsWith("sk-or-") ? stored : "";
    const keepHint = keepable
      ? "OpenRouter API key (Enter to keep): "
      : "OpenRouter API key (sk-or-...): ";
    const entered = (await rl.question(keepHint)).trim();
    const key = entered || keepable;
    if (!key) {
      console.log("No key stored. Set OPENROUTER_API_KEY or run /setup later.");
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

  if (ownsRl) rl.close();
  // Never persist an API key that already lives in the environment.
  const toSave =
    envKey && next.openaiCompatible?.apiKey === envKey
      ? {
          ...next,
          openaiCompatible: {
            baseUrl: next.openaiCompatible?.baseUrl ?? OPENROUTER_BASE_URL,
          },
        }
      : next;
  await saveConfig(toSave);
  // Re-apply env so the in-memory session sees OPENROUTER_API_KEY without storing it on disk.
  next = configFromEnv(toSave);
  console.log("");
  return next;
}

async function maybeHandleUpdateOnStart(config: HarnesConfig): Promise<HarnesConfig> {
  try {
    // Always hit the registry when auto-update is on so a bad local cache can't invent versions.
    const check = await checkForUpdate(VERSION, { force: Boolean(config.autoUpdate) });
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
    todos: TodoItem[];
    usage: SessionUsage;
    cwd: string;
    rl: readline.Interface;
    getMcp: () => McpManager;
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
      ctx.todos.length = 0;
      Object.assign(ctx.usage, emptySessionUsage());
      console.log(paint(ansi.muted, "Session cleared (context + session cost reset)."));
      return "ok";
    case "todos":
      if (ctx.todos.length === 0) {
        console.log(paint(ansi.muted, "No todos yet. The agent creates them for multi-step tasks."));
      } else {
        console.log(formatTodoList(ctx.todos));
      }
      return "ok";
    case "mcp":
      await printMcpStatus(ctx.getMcp());
      return "ok";
    case "skills": {
      const skills = await listSkills(ctx.cwd);
      console.log(formatSkillList(skills));
      return "ok";
    }
    case "models":
      await pickModelInteractive(ctx);
      return "ok";
    case "model":
      if (!arg) {
        await pickModelInteractive(ctx);
        return "ok";
      }
      await setModel(ctx, arg);
      return "ok";
    case "usage":
    case "cost":
      await printUsage(ctx.usage, ctx.getConfig(), ctx.history);
      return "ok";
    case "status": {
      printFullStatus(ctx.getConfig(), ctx.history, ctx.cwd, ctx.usage, ctx.todos);
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
        console.log("Usage: /mode auto|manual|ask|plan   (or ⌃T / ⇧Tab)");
        return "ok";
      }
      if (arg.toLowerCase() === "build") {
        console.log(paint(ansi.muted, 'Note: legacy alias "build" maps to mode auto (permission=build tools).'));
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
      const next = await runSetup(ctx.getConfig(), { nested: true, rl: ctx.rl });
      await ctx.setConfig(next);
      printWelcomeBox(next, ctx.cwd, ctx.history, { firstRun: false });
      return "ok";
    }
    default: {
      const suggestion = suggestSlashCommand(cmd);
      console.log(
        suggestion
          ? `Unknown command /${cmd}. Did you mean /${suggestion}? Try /help.`
          : `Unknown command /${cmd}. Try /help.`
      );
      return "ok";
    }
  }
}

function suggestSlashCommand(raw: string): string | undefined {
  const names = ["help", "setup", "status", "todos", "mcp", "skills", "model", "models", "mode", "usage", "cost", "update", "clear", "exit", "quit", "q", "h"];
  const needle = raw.toLowerCase();
  let best: string | undefined;
  let bestDist = 3;
  for (const name of names) {
    const d = editDistance(needle, name);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
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

async function printMcpStatus(mcp: McpManager): Promise<void> {
  if (!mcp.enabled) {
    console.log(paint(ansi.muted, "No MCP servers configured."));
    console.log(
      paint(
        ansi.muted,
        'Add one under "mcpServers" in ~/.config/harnes/config.json, e.g. { "mcpServers": { "docs": { "command": "npx", "args": ["-y", "some-mcp-server"] } } }'
      )
    );
    return;
  }
  console.log(paint(ansi.accentBright, "MCP servers"));
  const statuses = await mcp.describeStatus();
  for (const server of statuses) {
    if (server.status === "error") {
      console.log(`  ${server.name.padEnd(16)} ${paint(ansi.warm, "error")} — ${server.detail}`);
      continue;
    }
    console.log(`  ${server.name.padEnd(16)} ${paint(ansi.soft, "connected")} · ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`);
    for (const tool of server.tools) {
      console.log(`    ${paint(ansi.cmd, `mcp__${server.name}__${tool.name}`)} ${paint(ansi.muted, `(${tool.class})`)}`);
    }
  }
}

type ModelPick = { kind: "auto" } | { kind: "model"; model: ModelSpec };

async function loadSelectableModels(config: HarnesConfig): Promise<ModelSpec[]> {
  const endpoint = resolveChatEndpoint(config);
  if (endpoint.provider === "openrouter") {
    try {
      return await listOpenRouterModels({ apiKey: endpoint.apiKey });
    } catch {
      return MODEL_CATALOG;
    }
  }
  return MODEL_CATALOG;
}

async function pickModelInteractive(ctx: {
  getConfig: () => HarnesConfig;
  setConfig: (config: HarnesConfig) => Promise<void>;
  history: ChatMessage[];
  rl: readline.Interface;
}): Promise<void> {
  const config = ctx.getConfig();
  const session = resolveSession(config, ctx.history);
  const endpoint = resolveChatEndpoint(config);
  const models = await loadSelectableModels(config);

  const items: SelectItem<ModelPick>[] = [
    {
      value: { kind: "auto" },
      label: "auto (route by task)",
      detail: `→ ${session.routing === "pinned" ? "currently pinned" : session.model.name}`,
      current: session.routing !== "pinned",
    },
    ...models.map((model) => {
      const wire = model.openrouterModel ?? model.id;
      const current =
        session.routing === "pinned" &&
        (model.id === session.model.id || model.openrouterModel === session.wireId || wire === session.wireId);
      const ctxK = model.minContext >= 1000 ? `${Math.round(model.minContext / 1000)}k` : String(model.minContext);
      return {
        value: { kind: "model" as const, model },
        label: model.name,
        detail: `${model.tier} · ${ctxK} · ${wire}`,
        current,
      };
    }),
  ];

  const initialIndex = Math.max(
    0,
    items.findIndex((item) => item.current)
  );

  // Pause readline so the picker owns raw stdin (keys + mouse).
  ctx.rl.pause();
  let choice: ModelPick | null = null;
  try {
    choice = await selectFromList<ModelPick>({
      title: "Select model",
      items,
      initialIndex,
      pageSize: Math.min(14, Math.max(8, (process.stdout.rows || 24) - 10)),
      paint,
      colors: {
        accent: ansi.accent,
        accentBright: ansi.accentBright,
        muted: ansi.muted,
        soft: ansi.soft,
        warm: ansi.warm,
      },
    });
  } finally {
    ctx.rl.resume();
  }

  if (!choice) {
    console.log(paint(ansi.muted, "Model picker cancelled."));
    return;
  }
  if (choice.kind === "auto") {
    await setModel(ctx, "auto");
    return;
  }
  const pinId = endpoint.provider === "openrouter" ? (choice.model.openrouterModel ?? choice.model.id) : choice.model.id;
  await setModel(ctx, pinId);
}

async function setModel(
  ctx: {
    getConfig: () => HarnesConfig;
    setConfig: (config: HarnesConfig) => Promise<void>;
    history: ChatMessage[];
  },
  arg: string
): Promise<void> {
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
    const pinId = endpoint.provider === "openrouter" ? (model.openrouterModel ?? model.id) : model.id;
    await ctx.setConfig({ ...ctx.getConfig(), pinnedModelId: pinId });
    console.log(`Pinned ${model.name} (${pinId}) · ctx ${model.minContext.toLocaleString()}`);
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
  }
}

function summarizeTool(call: { name: string; arguments: Record<string, string> }): string {
  if (call.name === "write_file") return `write_file ${call.arguments.path ?? ""}`;
  if (call.name === "bash") {
    const cmd = call.arguments.command ?? "";
    return `bash ${cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd}`;
  }
  if (call.name === "read_file") return `read_file ${call.arguments.path ?? ""}`;
  if (call.name === "edit_file") return `edit_file ${call.arguments.path ?? ""}`;
  if (call.name === "list_dir") return `list_dir ${call.arguments.path || "."}`;
  if (call.name === "glob") return `glob ${call.arguments.pattern ?? "**"}`;
  if (call.name === "grep") {
    const pat = call.arguments.pattern ?? "";
    const scope = call.arguments.path || call.arguments.glob || "";
    return `grep ${pat.length > 40 ? `${pat.slice(0, 37)}…` : pat}${scope ? ` in ${scope}` : ""}`;
  }
  if (call.name === "run_tests") {
    if (call.arguments.command) return `run_tests cmd=${call.arguments.command.slice(0, 50)}`;
    if (call.arguments.script) return `run_tests script=${call.arguments.script}`;
    return "run_tests";
  }
  if (call.name === "skill") return call.arguments.name ? `skill ${call.arguments.name}` : "skill (list)";
  if (call.name === "todo_write") return "todo_write (update task list)";
  if (call.name === "git_status") return "git_status";
  if (call.name === "git_diff") return `git_diff ${call.arguments.path ?? ""}`.trim();
  if (call.name === "git_log") return "git_log";
  if (call.name === "git_commit") {
    const stage = call.arguments.stage_all === "false" || call.arguments.stage_all === "0" ? "staged-only" : "stage-all";
    return `git_commit (${stage}) ${JSON.stringify(call.arguments.message ?? "").slice(0, 60)}`;
  }
  if (call.name === "delegate") {
    const mode = call.arguments.mode === "build" ? "build" : "plan";
    const task = call.arguments.task ?? "";
    return `delegate (${mode}) ${task.length > 60 ? `${task.slice(0, 57)}…` : task}`;
  }
  if (call.name.startsWith(MCP_TOOL_PREFIX)) return call.name;
  return `${call.name} ${JSON.stringify(call.arguments).slice(0, 60)}`;
}

/** First meaningful line of mid-turn assistant narration for the live trail. */
function summarizeAssistantNarration(content: string, max = 120): string {
  const line =
    content
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

async function runTurn(
  prompt: string,
  config: HarnesConfig,
  backend: LocalBackend,
  mcp: McpManager,
  history: ChatMessage[],
  todos: TodoItem[],
  usage: SessionUsage,
  rl: readline.Interface,
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  if (!hasUsableApiKey(config) && config.provider !== "ollama") {
    console.log("No API key configured. Run /setup first.");
    return "no key";
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
      todos,
      mcp: mcp.enabled ? mcp : undefined,
      cwd,
      hooks: config.hooks,
      signal,
      complete: (input) => openaiCompatibleComplete(endpoint.baseUrl, endpoint.apiKey, input),
      onProgress: (event: LoopProgress) => {
        if (event.type === "thinking") {
          status.update(`Thinking · step ${event.step}`);
          return;
        }
        if (event.type === "assistant") {
          const line = summarizeAssistantNarration(event.content);
          if (line) status.note(paint(ansi.muted, `  ${line}`));
          status.update(`Working · step ${event.step}`);
          return;
        }
        if (event.type === "subagent") {
          status.note(paint(ansi.muted, `↳ subagent: ${event.task}`));
          status.update(`subagent · step ${event.step}`);
          return;
        }
        // tool
        if (event.phase === "start") {
          status.note(paint(ansi.accentBright, `→ ${summarizeTool(event)}`));
          status.update(`${event.name} · step ${event.step}`);
          return;
        }
        const mark = event.ok === false ? "✗" : "✓";
        const color = event.ok === false ? ansi.warm : ansi.muted;
        const preview = event.preview ? ` · ${event.preview}` : "";
        status.note(paint(color, `  ${mark} ${event.name}${preview}`));
        status.update(`Thinking · step ${event.step}`);
      },
      onApprove: async (call) => {
        if (signal?.aborted) return false;
        const mcpClass = call.name.startsWith(MCP_TOOL_PREFIX) ? mcp.classify(call.name) : undefined;
        if (!needsApproval(mode, call.name, mcpClass, call.arguments)) return true;
        status.stop();
        const answer = (await rl.question(paint(ansi.warm, `Allow ${summarizeTool(call)}? [Y/n] `)))
          .trim()
          .toLowerCase();
        if (signal?.aborted) return false;
        const ok = answer === "" || answer === "y" || answer === "yes";
        status = startStatusLine(ok ? call.name : "Running");
        return ok;
      },
    });

    const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
    const turnCost = result.usage.costUsd ?? 0;

    if (result.stoppedReason === "aborted") {
      status.stop(`✗ Interrupted · ${elapsedSec}s · ${result.steps} step${result.steps === 1 ? "" : "s"}`);
      // Do not commit a partial/invalid transcript into session history.
      return `✗ ${elapsedSec}s interrupted`;
    }

    usage.turns += 1;
    usage.agentSteps += result.steps;
    usage.toolCalls += result.messages.filter((message) => message.role === "tool").length;
    usage.promptTokens += result.usage.promptTokens;
    usage.completionTokens += result.usage.completionTokens;
    usage.costUsd += result.usage.costUsd ?? 0;

    history.length = 0;
    history.push(...compactHistoryMessages(result.messages));

    const costPart =
      endpoint.provider === "openrouter" || turnCost > 0
        ? ` · ${formatUsd(turnCost)} this turn · ${formatUsd(usage.costUsd)} session`
        : "";

    const summaryGlyph =
      result.stoppedReason === "complete" ? "✓" : result.stoppedReason === "max-steps" ? "…" : "!";
    const summaryLabel =
      result.stoppedReason === "complete"
        ? "Done"
        : result.stoppedReason === "max-steps"
          ? "Hit step limit"
          : result.stoppedReason;
    const summary = `${summaryGlyph} ${summaryLabel} · ${elapsedSec}s · ${result.steps} step${result.steps === 1 ? "" : "s"} · ${result.stoppedReason}${costPart}`;
    status.stop(summary);

    const assistants = result.messages.filter((message) => message.role === "assistant" && message.content.trim());
    const lastUseful = [...assistants].reverse().find((message) => !shouldAutoContinue(message.content));
    const last = lastUseful ?? assistants.at(-1);
    console.log("");
    if (last && shouldAutoContinue(last.content) && !lastUseful) {
      console.log(
        paint(
          ansi.muted,
          "(Model stalled mid-task instead of finishing. Say what you want next, or try /model with a stronger model.)"
        )
      );
    } else if (last?.content) console.log(last.content);
    else console.log(paint(ansi.muted, `(${result.stoppedReason} after ${result.steps} steps)`));

    // Compact sticky form for the always-on footer
    return `✓ ${elapsedSec}s/${result.steps} · ${formatUsd(turnCost)}`;
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

function printFullStatus(
  config: HarnesConfig,
  history: ChatMessage[],
  cwd: string,
  usage: SessionUsage,
  todos: TodoItem[]
): void {
  const session = resolveSession(config, history);
  const endpoint = resolveChatEndpoint(config);
  console.log(`provider   ${endpoint.provider}`);
  console.log(`baseUrl    ${endpoint.baseUrl}`);
  console.log(`key        ${maskKey(endpoint.apiKey)}`);
  console.log(`model      ${session.model.name} (${session.wireId}) [${session.routing}]`);
  console.log(`mode       ${session.modeLabel} (${session.mode}) · tools ${session.permissionMode}`);
  console.log(`autoUpdate ${config.autoUpdate ? "on" : "off"}`);
  console.log(`context    ~${formatTokenBar(session.tokensUsed, session.contextWindow)} (estimate)`);
  console.log(`cwd        ${shortCwd(cwd)}`);
  console.log(`history    ${history.length} messages`);
  console.log(`usage      turns=${usage.turns} tools=${usage.toolCalls} spend=${formatUsd(usage.costUsd)}`);
  console.log(`mcp        ${(config.mcpServers && Object.keys(config.mcpServers).length > 0) ? `${Object.keys(config.mcpServers).length} server(s)` : "off"}`);
  if (todos.length > 0) {
    const done = todos.filter((item) => item.status === "completed").length;
    console.log(`todos      ${done}/${todos.length} done · /todos for details`);
  }
  console.log(`version    ${VERSION}`);
}

function maskKey(key: string | undefined): string {
  if (!key) return "(none)";
  if (key === "ollama") return "ollama";
  if (key.length < 12) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Cap tool-result blobs kept in session history so context doesn't explode. */
const HISTORY_TOOL_RESULT_CAP = 4_000;

function compactHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter(
      (message) =>
        message.role !== "system" &&
        !(message.role === "user" && message.content === CONTINUE_NUDGE)
    )
    .map((message) => {
      if (message.role !== "tool" || message.content.length <= HISTORY_TOOL_RESULT_CAP) return message;
      const omitted = message.content.length - HISTORY_TOOL_RESULT_CAP;
      return {
        ...message,
        content: `${message.content.slice(0, HISTORY_TOOL_RESULT_CAP)}\n... truncated ${omitted} characters from history ...`,
      };
    });
}
