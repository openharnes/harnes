import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  assertAgentic,
  getModel,
  isRejectedModelId,
  listOpenRouterModels,
  MODEL_CATALOG,
  resetOpenRouterCatalogForTests,
  WEAK_MODEL_MESSAGE,
  wireModelId,
  type OpenRouterRawModel,
} from "./catalog.ts";
import { inferRouteKind, routeTask, DEFAULT_ROUTER } from "./router.ts";
import { runSmokeSuite, smokePassed } from "../smoke.ts";

function tempCachePath(): string {
  return path.join(os.tmpdir(), `harnes-test-openrouter-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function fakeFetch(models: OpenRouterRawModel[]): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ data: models }),
    }) as unknown as Response) as unknown as typeof fetch;
}

function countingFakeFetch(models: OpenRouterRawModel[]): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    calls += 1;
    return (await fakeFetch(models)(...args)) as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function throwingFetch(): typeof fetch {
  return (async () => {
    throw new Error("network unavailable");
  }) as unknown as typeof fetch;
}

describe("model catalog", () => {
  it("rejects weak models that fail the agentic loop", () => {
    assert.equal(isRejectedModelId("gpt-oss:20b"), true);
    assert.throws(() => assertAgentic({ id: "gpt-oss:20b", providerModel: "gpt-oss:20b", toolCalling: "unreliable" }), {
      message: WEAK_MODEL_MESSAGE,
    });
  });

  it("defaults strong-open to Qwen3 Coder 30B", () => {
    const model = getModel("qwen3-coder-30b");
    assert.equal(model.tier, "strong-open");
    assert.equal(model.kind, "open");
    assert.equal(model.toolCalling, "reliable");
  });

  it("maps OpenRouter wire ids", () => {
    const model = getModel("qwen3-coder-30b");
    assert.equal(wireModelId(model, "openrouter"), "qwen/qwen3-coder");
    assert.equal(wireModelId(model, "ollama"), "qwen3-coder:30b");
    assert.equal(getModel("qwen/qwen3-coder").id, "qwen3-coder-30b");
  });

  it("lists only curated models", () => {
    assert.ok(MODEL_CATALOG.every((model) => model.minContext >= 32768));
    assert.ok(MODEL_CATALOG.every((model) => Boolean(model.openrouterModel)));
  });
});

describe("hybrid routing", () => {
  it("sends explore and compact to fast-open", () => {
    assert.equal(routeTask("explore").tier, "fast-open");
    assert.equal(routeTask("compact").tier, "fast-open");
  });

  it("sends build to strong-open", () => {
    assert.equal(routeTask("build").id, "qwen3-coder-30b");
  });

  it("uses frontier only when BYOK is enabled", () => {
    assert.equal(routeTask("hard", { ...DEFAULT_ROUTER, allowFrontier: false }).kind, "open");
    assert.equal(routeTask("hard", { ...DEFAULT_ROUTER, allowFrontier: true }).tier, "frontier-byok");
  });

  it("infers route kind from the prompt", () => {
    assert.equal(inferRouteKind("whats in this repo?"), "explore");
    assert.equal(inferRouteKind("architect a multi-file migrate"), "hard");
    assert.equal(inferRouteKind("add a retry policy"), "build");
  });
});

describe("smoke suite", () => {
  it("passes against default routing", () => {
    const results = runSmokeSuite(DEFAULT_ROUTER);
    assert.equal(smokePassed(results), true, results.filter((r) => !r.ok).map((r) => r.name).join(", "));
  });
});

describe("live OpenRouter catalog", () => {
  beforeEach(() => {
    resetOpenRouterCatalogForTests();
  });

  it("uses a fresh cache without hitting the network", async () => {
    const cachePath = tempCachePath();
    const cachedModel: OpenRouterRawModel = {
      id: "deepseek/deepseek-coder-v2-instruct",
      name: "DeepSeek Coder V2 Instruct",
      context_length: 128000,
      supported_parameters: ["tools"],
    };
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), models: [cachedModel] }), "utf8");

    const { fetchImpl, calls } = countingFakeFetch([]);
    const models = await listOpenRouterModels({ cachePath, fetchImpl });

    assert.equal(calls(), 0, "fresh cache should not trigger a network call");
    assert.ok(models.some((m) => m.id === "deepseek/deepseek-coder-v2-instruct"));

    await fs.unlink(cachePath).catch(() => {});
  });

  it("falls back to a stale cache when the network is unavailable", async () => {
    const cachePath = tempCachePath();
    const staleModel: OpenRouterRawModel = {
      id: "qwen/qwen3-coder-plus",
      name: "Qwen3 Coder Plus",
      context_length: 131072,
      supported_parameters: ["tools"],
    };
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({ fetchedAt: Date.now() - 2 * 60 * 60 * 1000, models: [staleModel] }),
      "utf8"
    );

    const models = await listOpenRouterModels({ cachePath, fetchImpl: throwingFetch() });

    assert.ok(models.some((m) => m.id === "qwen/qwen3-coder-plus"), "stale cache should still be used offline");

    await fs.unlink(cachePath).catch(() => {});
  });

  it("falls back to the static curated list with no cache and no network", async () => {
    const cachePath = tempCachePath();

    const models = await listOpenRouterModels({ cachePath, fetchImpl: throwingFetch() });

    assert.deepEqual(
      models.map((m) => m.id).sort(),
      MODEL_CATALOG.map((m) => m.id).sort()
    );
  });

  it("resolves an OpenRouter slug discovered live via getModel()", async () => {
    const cachePath = tempCachePath();
    const raw: OpenRouterRawModel = {
      id: "meta-llama/llama-3.1-70b-instruct",
      name: "Llama 3.1 70B Instruct",
      context_length: 131072,
      supported_parameters: ["tools", "tool_choice"],
    };

    await listOpenRouterModels({ cachePath, fetchImpl: fakeFetch([raw]) });

    const model = getModel("meta-llama/llama-3.1-70b-instruct");
    assert.equal(model.kind, "open");
    assert.equal(model.tier, "strong-open");
    assert.equal(model.providerModel, "llama-3.1-70b-instruct");
    assert.equal(model.openrouterModel, "meta-llama/llama-3.1-70b-instruct");
    assert.equal(model.toolCalling, "reliable");
    assert.equal(model.minContext, 131072);
  });

  it("rejects tiny/weak OpenRouter listings instead of adding them to the catalog", async () => {
    const cachePath = tempCachePath();
    const weakByName: OpenRouterRawModel = {
      id: "qwen/qwen3-coder-tinyllama",
      name: "Qwen3 Coder TinyLlama",
      context_length: 32768,
      supported_parameters: ["tools"],
    };
    const weakByContext: OpenRouterRawModel = {
      id: "deepseek/deepseek-coder-nano",
      name: "DeepSeek Coder Nano",
      context_length: 4096,
      supported_parameters: ["tools"],
    };

    const models = await listOpenRouterModels({ cachePath, fetchImpl: fakeFetch([weakByName, weakByContext]) });

    assert.ok(!models.some((m) => m.id === weakByName.id));
    assert.ok(!models.some((m) => m.id === weakByContext.id));
    assert.throws(() => getModel(weakByName.id), /Unknown model/);
    assert.throws(() => getModel(weakByContext.id), /Unknown model/);
  });

  it("leaves the router's strong-open default untouched by the live catalog", async () => {
    const cachePath = tempCachePath();
    const raw: OpenRouterRawModel = {
      id: "meta-llama/llama-3.1-70b-instruct",
      name: "Llama 3.1 70B Instruct",
      context_length: 131072,
      supported_parameters: ["tools"],
    };

    await listOpenRouterModels({ cachePath, fetchImpl: fakeFetch([raw]) });

    assert.equal(routeTask("build").id, "qwen3-coder-30b");
  });
});
