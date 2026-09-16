import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configFromEnv, DEFAULT_CONFIG, hasUsableApiKey, resolveChatEndpoint } from "./config.ts";
import { OPENROUTER_BASE_URL } from "./models/catalog.ts";

describe("config", () => {
  it("prefers OpenRouter when OPENROUTER_API_KEY is set", () => {
    const previous = snapshotEnv(["OPENROUTER_API_KEY", "HARNES_PROVIDER", "HARNES_MODEL_BASE_URL", "HARNES_MODEL_API_KEY"]);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    delete process.env.HARNES_PROVIDER;
    delete process.env.HARNES_MODEL_BASE_URL;
    try {
      const config = configFromEnv();
      const endpoint = resolveChatEndpoint(config);
      assert.equal(endpoint.provider, "openrouter");
      assert.equal(endpoint.baseUrl, OPENROUTER_BASE_URL);
      assert.equal(endpoint.apiKey, "sk-or-test");
      assert.equal(hasUsableApiKey(config), true);
      assert.equal(DEFAULT_CONFIG.provider, "ollama");
    } finally {
      restoreEnv(previous);
    }
  });

  it("treats ollama as usable without a cloud key", () => {
    assert.equal(hasUsableApiKey({ ...DEFAULT_CONFIG, provider: "ollama" }), true);
  });
});

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of keys) out[key] = process.env[key];
  return out;
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
