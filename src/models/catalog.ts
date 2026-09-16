import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type QualityTier = "fast-open" | "strong-open" | "frontier-byok";

export type ModelKind = "open" | "frontier";

export type ModelProvider = "openai-compatible" | "openrouter" | "ollama";

export interface ModelSpec {
  id: string;
  name: string;
  tier: QualityTier;
  kind: ModelKind;
  /** Default / Ollama / vLLM model id */
  providerModel: string;
  /** OpenRouter slug when served via openrouter.ai */
  openrouterModel?: string;
  minContext: number;
  toolCalling: "reliable" | "experimental" | "unreliable";
  notes: string;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

export const WEAK_MODEL_MESSAGE =
  "This model is too weak for the agentic loop (tool-call failures). Use strong-open or frontier-byok.";

/** Curated models known to tool-call well enough for Harnes. Also the offline fallback catalog. */
export const MODEL_CATALOG: ModelSpec[] = [
  {
    id: "qwen3-coder-30b",
    name: "Qwen3 Coder 30B",
    tier: "strong-open",
    kind: "open",
    providerModel: "qwen3-coder:30b",
    openrouterModel: "qwen/qwen3-coder",
    minContext: 65536,
    toolCalling: "reliable",
    notes: "Default strong-open. OpenRouter: qwen/qwen3-coder. Local: Ollama/vLLM.",
  },
  {
    id: "qwen3-coder-8b",
    name: "Qwen3 Coder 8B",
    tier: "fast-open",
    kind: "open",
    providerModel: "qwen3-coder:8b",
    openrouterModel: "qwen/qwen3-coder-flash",
    minContext: 32768,
    toolCalling: "reliable",
    notes: "Explore, titles, and compaction — not hard multi-file builds.",
  },
  {
    id: "deepseek-v3",
    name: "DeepSeek V3",
    tier: "strong-open",
    kind: "open",
    providerModel: "deepseek-chat",
    openrouterModel: "deepseek/deepseek-chat-v3-0324",
    minContext: 65536,
    toolCalling: "reliable",
    notes: "Open-weight via OpenRouter / Fireworks / Together / self-hosted vLLM.",
  },
  {
    id: "claude-sonnet",
    name: "Claude Sonnet",
    tier: "frontier-byok",
    kind: "frontier",
    providerModel: "claude-sonnet-4-5",
    openrouterModel: "anthropic/claude-sonnet-4.5",
    minContext: 200000,
    toolCalling: "reliable",
    notes: "BYOK via OpenRouter or Anthropic. Optional upgrade for hard architecture work.",
  },
  {
    id: "gpt-5",
    name: "GPT-5",
    tier: "frontier-byok",
    kind: "frontier",
    providerModel: "gpt-5",
    openrouterModel: "openai/gpt-5",
    minContext: 128000,
    toolCalling: "reliable",
    notes: "BYOK via OpenRouter or OpenAI. Optional upgrade for hard architecture work.",
  },
];

const REJECTED_IDS = new Set([
  "gpt-oss:20b",
  "llama3.2:3b",
  "phi3:mini",
  "tinyllama",
  "gemma:2b",
]);

/** id/name substrings that mark an OpenRouter listing as too small or unproven for the agentic loop. */
const WEAK_OPENROUTER_PATTERN =
  /(tinyllama|gpt-oss.?20b|phi-?3-?mini|gemma.?2b|\b0\.5b\b|\b1b\b|\b2b\b|\b3b\b|\b4b\b)/i;

/** id/name substrings for models worth surfacing in the coding-agent catalog. */
const CODING_CAPABLE_PATTERN =
  /(qwen[^/]*coder|deepseek|claude|gpt-|gemini|llama.*(70b|72b|405b)|mixtral|codestral)/i;

const FRONTIER_PROVIDERS = new Set(["anthropic", "openai", "google"]);
const FAST_TIER_PATTERN = /(flash|mini|lite|\b7b\b|\b8b\b|\b9b\b)/i;

export function normalizeModelId(id: string): string {
  // Shell/path typos sometimes produce "~provider/model" or quoted ids.
  return id.trim().replace(/^~+/, "").replace(/^["']|["']$/g, "");
}

export function getModel(id: string): ModelSpec {
  const normalized = normalizeModelId(id);
  const matches = (model: ModelSpec) =>
    model.id === normalized || model.providerModel === normalized || model.openrouterModel === normalized;
  const found = MODEL_CATALOG.find(matches) ?? dynamicCatalog.find(matches);
  if (!found) {
    throw new Error(`Unknown model '${id}'. Run \`${CLI_HINT} models\` for the curated list.`);
  }
  assertAgentic(found);
  return found;
}

export function modelsForTier(tier: QualityTier): ModelSpec[] {
  return MODEL_CATALOG.filter((model) => model.tier === tier);
}

export function defaultModelForTier(tier: QualityTier): ModelSpec {
  const models = modelsForTier(tier);
  if (models.length === 0) {
    throw new Error(`No curated models for tier ${tier}`);
  }
  return models[0];
}

export function assertAgentic(model: Pick<ModelSpec, "id" | "providerModel" | "toolCalling">): void {
  if (REJECTED_IDS.has(model.id) || REJECTED_IDS.has(model.providerModel) || model.toolCalling === "unreliable") {
    throw new Error(WEAK_MODEL_MESSAGE);
  }
}

export function isRejectedModelId(id: string): boolean {
  return REJECTED_IDS.has(id);
}

/** Model id to send on the wire for the active provider. */
export function wireModelId(model: ModelSpec, provider: ModelProvider): string {
  if (provider === "openrouter") {
    return model.openrouterModel ?? model.providerModel;
  }
  return model.providerModel;
}

// --- Live OpenRouter catalog -------------------------------------------------

/** Subset of the OpenRouter /models response we care about. */
export interface OpenRouterRawModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  [extra: string]: unknown;
}

interface OpenRouterCacheFile {
  fetchedAt: number;
  models: OpenRouterRawModel[];
}

export const OPENROUTER_CACHE_PATH = path.join(os.homedir(), ".cache", "harnes", "openrouter-models.json");
export const OPENROUTER_CACHE_TTL_MS = 60 * 60 * 1000;

export interface ListOpenRouterModelsOptions {
  apiKey?: string;
  cachePath?: string;
  ttlMs?: number;
  forceRefresh?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Extra models discovered via listOpenRouterModels(), searched by getModel() after MODEL_CATALOG. */
let dynamicCatalog: ModelSpec[] = [];

function isWeakOpenRouterModel(raw: OpenRouterRawModel): boolean {
  const haystack = `${raw.id} ${raw.name ?? ""}`.toLowerCase();
  if (WEAK_OPENROUTER_PATTERN.test(haystack)) return true;
  if (typeof raw.context_length === "number" && raw.context_length > 0 && raw.context_length < 8192) return true;
  const params = raw.supported_parameters ?? [];
  if (params.length > 0 && !params.includes("tools") && !params.includes("tool_choice")) return true;
  return false;
}

function isCodingCapable(raw: OpenRouterRawModel): boolean {
  return CODING_CAPABLE_PATTERN.test(`${raw.id} ${raw.name ?? ""}`);
}

function toolCallingFor(raw: OpenRouterRawModel): ModelSpec["toolCalling"] {
  const params = raw.supported_parameters ?? [];
  if (params.includes("tools")) return "reliable";
  if (params.includes("tool_choice") || params.includes("functions")) return "experimental";
  return "unreliable";
}

function mapOpenRouterModel(raw: OpenRouterRawModel): ModelSpec {
  const provider = raw.id.includes("/") ? raw.id.split("/")[0] : raw.id;
  const localName = raw.id.includes("/") ? raw.id.split("/").slice(1).join("/") : raw.id;
  const kind: ModelKind = FRONTIER_PROVIDERS.has(provider) ? "frontier" : "open";
  const tier: QualityTier =
    kind === "frontier" ? "frontier-byok" : FAST_TIER_PATTERN.test(raw.id) ? "fast-open" : "strong-open";

  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    tier,
    kind,
    providerModel: localName,
    openrouterModel: raw.id,
    minContext: raw.context_length ?? 0,
    toolCalling: toolCallingFor(raw),
    notes: `Auto-discovered from OpenRouter (${raw.id}).`,
  };
}

async function readCache(cachePath: string): Promise<OpenRouterCacheFile | null> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as OpenRouterCacheFile;
    if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.models)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, models: OpenRouterRawModel[], fetchedAt: number): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({ fetchedAt, models } satisfies OpenRouterCacheFile), "utf8");
  } catch {
    // Best-effort cache; a write failure should never break model resolution.
  }
}

async function fetchOpenRouterModelsRaw(
  fetchImpl: typeof fetch,
  apiKey: string | undefined
): Promise<OpenRouterRawModel[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl(`${OPENROUTER_BASE_URL}/models`, { headers });
  if (!response.ok) {
    throw new Error(`OpenRouter models request failed: ${response.status}`);
  }
  const body = (await response.json()) as { data?: OpenRouterRawModel[] };
  return body.data ?? [];
}

/**
 * Fetches the live OpenRouter model catalog (cached ~1h in ~/.cache/harnes/openrouter-models.json),
 * maps it onto ModelSpec, and merges it with the curated MODEL_CATALOG. Falls back to a stale cache
 * on network failure, and to MODEL_CATALOG alone if there is no cache and no network.
 */
export async function listOpenRouterModels(options: ListOpenRouterModelsOptions = {}): Promise<ModelSpec[]> {
  const {
    apiKey = process.env.OPENROUTER_API_KEY,
    cachePath = OPENROUTER_CACHE_PATH,
    ttlMs = OPENROUTER_CACHE_TTL_MS,
    forceRefresh = false,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  } = options;

  const cached = await readCache(cachePath);
  const cacheFresh = cached !== null && now() - cached.fetchedAt < ttlMs;

  let raw: OpenRouterRawModel[] | null = null;

  if (!forceRefresh && cacheFresh) {
    raw = cached!.models;
  } else {
    try {
      if (!fetchImpl) throw new Error("fetch is not available in this environment");
      raw = await fetchOpenRouterModelsRaw(fetchImpl, apiKey);
      await writeCache(cachePath, raw, now());
    } catch {
      raw = cached ? cached.models : null;
    }
  }

  if (!raw) {
    dynamicCatalog = [];
    return [...MODEL_CATALOG];
  }

  dynamicCatalog = raw
    .filter((model) => isCodingCapable(model) && !isWeakOpenRouterModel(model))
    .map(mapOpenRouterModel)
    .filter((model) => !MODEL_CATALOG.some((curated) => curated.openrouterModel === model.openrouterModel));

  return [...MODEL_CATALOG, ...dynamicCatalog];
}

/** Test-only: clears models discovered via listOpenRouterModels() so getModel() reverts to MODEL_CATALOG only. */
export function resetOpenRouterCatalogForTests(): void {
  dynamicCatalog = [];
}

const CLI_HINT = "harnes";
