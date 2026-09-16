#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { configFromEnv, loadConfig, resolveChatEndpoint, saveConfig, type HarnesConfig } from "./config.ts";
import { LocalBackend } from "./exec/local.ts";
import { openaiCompatibleComplete, runAgentLoop } from "./loop.ts";
import { MODEL_CATALOG, wireModelId } from "./models/catalog.ts";
import { inferRouteKind, routeTask } from "./models/router.ts";
import { buildOpenCodeConfig } from "./opencode/config.ts";
import { CLI_NAME, ONE_LINER, PITCH, PRODUCT_NAME, SHORT_NAME } from "./positioning.ts";
import { startRepl } from "./repl.ts";
import { runSmokeSuite, smokePassed } from "./smoke.ts";

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
  ${CLI_NAME} run <prompt>         one-shot agent turn
  ${CLI_NAME} opencode-config      print OpenCode-compatible config

Env:
  OPENROUTER_API_KEY
  HARNES_PROVIDER=openrouter|ollama|openai-compatible
  HARNES_MODEL_BASE_URL  HARNES_MODEL_API_KEY
`);
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
  const kind = inferRouteKind(prompt);
  const model = routeTask(kind, config.router);
  const backend = new LocalBackend(process.cwd());
  const endpoint = resolveChatEndpoint(config);
  const wireModel = wireModelId(model, endpoint.provider);
  try {
    const result = await runAgentLoop({
      prompt,
      model: { ...model, providerModel: wireModel },
      backend,
      permissionMode: config.permissionMode,
      complete: (input) => openaiCompatibleComplete(endpoint.baseUrl, endpoint.apiKey, input),
    });
    const last = [...result.messages].reverse().find((message) => message.role === "assistant");
    if (last?.content) console.log(last.content);
    else console.log(`(${result.stoppedReason} after ${result.steps} steps)`);
  } finally {
    await backend.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
