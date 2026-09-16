import type { HarnesConfig } from "../config.ts";
import { MODEL_CATALOG, wireModelId } from "../models/catalog.ts";

/**
 * OpenCode-compatible config Harnes writes so `opencode` can be an
 * optional interactive front-end with Harnes defaults.
 */
export function buildOpenCodeConfig(config: HarnesConfig): Record<string, unknown> {
  const strong = MODEL_CATALOG.find((model) => model.id === config.router.strongOpenId);
  const fast = MODEL_CATALOG.find((model) => model.id === config.router.fastOpenId);
  const baseUrl = config.openaiCompatible?.baseUrl ?? "http://127.0.0.1:11434/v1";
  const strongWire = strong ? wireModelId(strong, config.provider) : "qwen/qwen3-coder";
  const fastWire = fast ? wireModelId(fast, config.provider) : "qwen/qwen3-coder-flash";

  return {
    $schema: "https://opencode.ai/config.json",
    model: `openharnes/${strongWire}`,
    small_model: `openharnes/${fastWire}`,
    provider: {
      openharnes: {
        npm: "@ai-sdk/openai-compatible",
        name: config.provider === "openrouter" ? "OpenHarnes (OpenRouter)" : "OpenHarnes",
        options: {
          baseURL: baseUrl,
          apiKey: config.openaiCompatible?.apiKey ?? "ollama",
        },
        models: Object.fromEntries(
          MODEL_CATALOG.map((model) => {
            const id = wireModelId(model, config.provider);
            return [id, { name: model.name }];
          })
        ),
      },
    },
    permission: {
      bash: "ask",
    },
    agent: {
      build: { description: "Harnes build agent — full tools", mode: "primary" },
      plan: { description: "Harnes plan agent — read-only tools", mode: "primary" },
    },
    harnes: {
      provider: config.provider,
    },
  };
}
