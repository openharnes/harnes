#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { configFromEnv, loadConfig, resolveChatEndpoint, saveConfig, type HarnesConfig } from "./config.ts";
import { LocalBackend } from "./exec/local.ts";
import { needsApproval } from "./exec/types.ts";
import { formatEvalReport, runEvalSuite } from "./eval/runner.ts";
import { openaiCompatibleComplete, runAgentLoop } from "./loop.ts";
import { MODEL_CATALOG, wireModelId } from "./models/catalog.ts";
import { inferRouteKind, routeTask } from "./models/router.ts";
import { buildOpenCodeConfig } from "./opencode/config.ts";
import { CLI_NAME, ONE_LINER, PITCH, PRODUCT_NAME, SHORT_NAME } from "./positioning.ts";
import { startRepl } from "./repl.ts";
import { resolveSession } from "./session.ts";
import { runSmokeSuite, smokePassed } from "./smoke.ts";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const config = configFromEnv(await loadConfig());

  // Bare `harnes` opens the persistent session.
  if (!command) {
    await startRepl(config);
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  switch (command) {
    case "init":
      await cmdInit(config);
      return;
    case "setup":
      await startRepl({ ...config, setupComplete: false });
      return;
    case "models":
      cmdModels();
      return;
    case "route":
      cmdRoute(rest.join(" "), config);
      return;
    case "smoke":
      cmdSmoke(config);
      return;
    case "opencode-config":
      console.log(JSON.stringify(buildOpenCodeConfig(config), null, 2));
      return;
    case "run":
      await cmdRun(rest.join(" "), config);
      return;
    case "eval":
      await cmdEval(rest, config);
      return;
    default:
      if (command.startsWith("-")) {
        printHelp();
        process.exitCode = 1;
        return;
      }
      // `harnes explain this` → one-shot run for scripting
      await cmdRun([command, ...rest].join(" "), config);
  }
}

function printHelp(): void {
  console.log(`${PRODUCT_NAME} (${SHORT_NAME})
${ONE_LINER}
${PITCH}

Usage:
  ${CLI_NAME}                      open persistent session (welcome + setup on first run)
  ${CLI_NAME} setup                configure OpenRouter / Ollama
  ${CLI_NAME} init                 write ~/.config/harnes/config.json
  ${CLI_NAME} models               curated models
  ${CLI_NAME} route <prompt>       hybrid routing
  ${CLI_NAME} smoke                catalog checks
  ${CLI_NAME} run <prompt>         one-shot agent turn (uses pinned model; no TTY approvals)
  ${CLI_NAME} eval [--live] [--first-step]   tool-call + outcome suite (evals/README.md)
  ${CLI_NAME} opencode-config      print OpenCode-compatible config

Session (TTY): /help · /mode auto|manual|ask|plan · ⌃T cycle · ask/manual approvals only in the REPL

Env:
  OPENROUTER_API_KEY
  HARNES_PROVIDER=openrouter|ollama|openai-compatible
  HARNES_MODEL_BASE_URL  HARNES_MODEL_API_KEY
`);
}

async function cmdEval(argv: string[], config: HarnesConfig): Promise<void> {
  const live = argv.includes("--live");
  const firstStep = argv.includes("--first-step");
  const modelFlag = flagValue(argv, "--model");
  const tagFlag = flagValue(argv, "--tag");
  const taskFlag = flagValue(argv, "--task");
  const report = await runEvalSuite({
    config,
    live,
    liveMode: firstStep ? "first-step" : "loop",
    modelId: modelFlag,
    tags: tagFlag ? tagFlag.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    taskIds: taskFlag ? taskFlag.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
  });
  console.log(formatEvalReport(report));
  if (report.failed > 0) process.exitCode = 1;
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

async function cmdInit(config: HarnesConfig): Promise<void> {
  const file = await saveConfig({ ...config, setupComplete: true });
  const ocPath = path.join(path.dirname(file), "opencode.json");
  await writeFile(ocPath, `${JSON.stringify(buildOpenCodeConfig(config), null, 2)}\n`);
  console.log(`Wrote ${file}`);
  console.log(`Wrote ${ocPath}`);
  console.log(ONE_LINER);
}

function cmdModels(): void {
  console.log(`${"tier".padEnd(14)} ${"id".padEnd(20)} ${"openrouter".padEnd(36)} name`);
  for (const model of MODEL_CATALOG) {
    console.log(
      `${model.tier.padEnd(14)} ${model.id.padEnd(20)} ${(model.openrouterModel ?? "-").padEnd(36)} ${model.name}`
    );
  }
}

function cmdRoute(prompt: string, config: HarnesConfig): void {
  if (!prompt) {
    console.error("Usage: harnes route <prompt>");
    process.exitCode = 1;
    return;
  }
  const kind = inferRouteKind(prompt);
  const model = routeTask(kind, config.router);
  const wire = wireModelId(model, config.provider);
  console.log(`${kind} -> ${model.tier} (${model.id}) via ${config.provider} as ${wire}`);
}

function cmdSmoke(config: HarnesConfig): void {
  const results = runSmokeSuite(config.router);
  for (const result of results) {
    console.log(`${result.ok ? "ok" : "FAIL"}  ${result.name}  ${result.detail}`);
  }
  if (!smokePassed(results)) process.exitCode = 1;
}

async function cmdRun(prompt: string, config: HarnesConfig): Promise<void> {
  if (!prompt) {
    throw new Error("Usage: harnes run <prompt>");
  }
  const session = resolveSession(config, [], prompt);
  const backend = new LocalBackend(process.cwd());
  const endpoint = resolveChatEndpoint(config);
  const canAsk = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = canAsk ? readline.createInterface({ input, output, terminal: true }) : undefined;
  try {
    if (!canAsk && (session.mode === "ask" || session.mode === "manual")) {
      console.error(
        `Note: mode is ${session.modeLabel} but stdin is not a TTY — running without approval prompts (as auto). Use the REPL for ask/manual.`
      );
    }
    const result = await runAgentLoop({
      prompt,
      model: { ...session.model, providerModel: session.wireId },
      backend,
      permissionMode: session.permissionMode,
      onApprove: async (call) => {
        if (!rl || session.mode === "auto" || session.mode === "plan") return true;
        if (!needsApproval(session.mode, call.name, undefined, call.arguments)) return true;
        const answer = (await rl.question(`Allow ${call.name}? [Y/n] `)).trim().toLowerCase();
        return answer === "" || answer === "y" || answer === "yes";
      },
      complete: (input) => openaiCompatibleComplete(endpoint.baseUrl, endpoint.apiKey, input),
    });
    const last = [...result.messages].reverse().find((message) => message.role === "assistant");
    if (last?.content) console.log(last.content);
    else console.log(`(${result.stoppedReason} after ${result.steps} steps)`);
  } finally {
    rl?.close();
    await backend.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
