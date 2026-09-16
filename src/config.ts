import type { PermissionMode, SessionMode } from "./exec/types.ts";
import {
  OLLAMA_BASE_URL,
  OPENROUTER_BASE_URL,
  type ModelProvider,
  type QualityTier,
} from "./models/catalog.ts";
import { DEFAULT_ROUTER, type RouterConfig } from "./models/router.ts";

export interface HarnesConfig {
  permissionMode: PermissionMode;
  /** auto routes model + tool permissions per prompt; plan/build pin tools. */
  sessionMode: SessionMode;
  defaultTier: QualityTier;
  router: RouterConfig;
  /** Active chat provider. openrouter is preferred when OPENROUTER_API_KEY is set. */
  provider: ModelProvider;
  openaiCompatible?: {
    baseUrl: string;
    apiKey?: string;
  };
  /** Pin a catalog id; unset = auto-route. */
  pinnedModelId?: string;
  /** Set true after first-run setup completes. */
  setupComplete?: boolean;
}

export const DEFAULT_CONFIG: HarnesConfig = {
  permissionMode: "build",
  sessionMode: "auto",
  defaultTier: "strong-open",
  router: DEFAULT_ROUTER,
  provider: "ollama",
  openaiCompatible: {
    baseUrl: OLLAMA_BASE_URL,
    apiKey: "ollama",
  },
  setupComplete: false,
};

export function configPath(): string {
  return process.env.HARNES_CONFIG ?? `${homedir()}/.config/harnes/config.json`;
}

function homedir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? ".";
}

export async function loadConfig(): Promise<HarnesConfig> {
  const { readFile } = await import("node:fs/promises");
  const file = configPath();
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<HarnesConfig> & {
      exec?: string;
      openhost?: unknown;
    };
    // Drop legacy OpenHost fields if present in an old config file.
    const { exec: _exec, openhost: _openhost, ...rest } = raw;
    const merged: HarnesConfig = {
      ...DEFAULT_CONFIG,
      ...rest,
      sessionMode: rest.sessionMode ?? DEFAULT_CONFIG.sessionMode,
      router: { ...DEFAULT_CONFIG.router, ...rest.router },
      provider: rest.provider ?? DEFAULT_CONFIG.provider,
      openaiCompatible: {
        baseUrl:
          rest.openaiCompatible?.baseUrl ??
          DEFAULT_CONFIG.openaiCompatible?.baseUrl ??
          OLLAMA_BASE_URL,
        apiKey: rest.openaiCompatible?.apiKey ?? DEFAULT_CONFIG.openaiCompatible?.apiKey,
      },
    };
    return configFromEnv(merged);
  } catch {
    return configFromEnv({ ...DEFAULT_CONFIG });
  }
}

export async function saveConfig(config: HarnesConfig): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return file;
}

export function configFromEnv(base: HarnesConfig = DEFAULT_CONFIG): HarnesConfig {
  const openRouterKey = process.env.OPENROUTER_API_KEY ?? process.env.HARNES_OPENROUTER_API_KEY;
  const explicitProvider = process.env.HARNES_PROVIDER as ModelProvider | undefined;
  const explicitBase = process.env.HARNES_MODEL_BASE_URL;
  const explicitKey = process.env.HARNES_MODEL_API_KEY;

  let provider: ModelProvider = explicitProvider ?? base.provider;
  let baseUrl = explicitBase ?? base.openaiCompatible?.baseUrl ?? OLLAMA_BASE_URL;
  let apiKey = explicitKey ?? base.openaiCompatible?.apiKey;

  if (!explicitProvider && !explicitBase && openRouterKey) {
    provider = "openrouter";
    baseUrl = OPENROUTER_BASE_URL;
    apiKey = openRouterKey;
  } else if (provider === "openrouter") {
    baseUrl = explicitBase ?? OPENROUTER_BASE_URL;
    apiKey = explicitKey ?? openRouterKey ?? apiKey;
  } else if (provider === "ollama") {
    baseUrl = explicitBase ?? OLLAMA_BASE_URL;
    apiKey = explicitKey ?? apiKey ?? "ollama";
  }

  return {
    ...base,
    provider,
    openaiCompatible: {
      baseUrl,
      apiKey,
    },
  };
}

export function resolveChatEndpoint(config: HarnesConfig): {
  baseUrl: string;
  apiKey?: string;
  provider: ModelProvider;
} {
  return {
    provider: config.provider,
    baseUrl: config.openaiCompatible?.baseUrl ?? OLLAMA_BASE_URL,
    apiKey: config.openaiCompatible?.apiKey,
  };
}

export function hasUsableApiKey(config: HarnesConfig): boolean {
  const key = config.openaiCompatible?.apiKey?.trim();
  if (config.provider === "ollama") return true;
  if (config.provider === "openrouter") {
    return Boolean(key && key.startsWith("sk-or-"));
  }
  return Boolean(key && key !== "ollama");
}
