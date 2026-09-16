import { OPENROUTER_BASE_URL } from "../models/catalog.ts";

export interface OpenRouterKeyUsage {
  usage: number;
  usageDaily: number;
  usageWeekly: number;
  usageMonthly: number;
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string | null;
  label: string | null;
}

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD cost when the provider reports it (OpenRouter does). */
  costUsd?: number;
}

/** Format a USD amount for the CLI (enough digits for small OpenRouter costs). */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(6)}`;
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/**
 * Key-scoped usage from OpenRouter (`GET /api/v1/key`).
 * Works with a normal API key — daily / weekly / monthly / limit.
 */
export async function fetchOpenRouterKeyUsage(
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<OpenRouterKeyUsage> {
  const response = await fetchImpl(`${OPENROUTER_BASE_URL}/key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter /key failed (${response.status}): ${await response.text()}`);
  }
  const json = (await response.json()) as {
    data?: {
      usage?: number;
      usage_daily?: number;
      usage_weekly?: number;
      usage_monthly?: number;
      limit?: number | null;
      limit_remaining?: number | null;
      limit_reset?: string | null;
      label?: string | null;
    };
  };
  const data = json.data ?? {};
  return {
    usage: Number(data.usage ?? 0),
    usageDaily: Number(data.usage_daily ?? 0),
    usageWeekly: Number(data.usage_weekly ?? 0),
    usageMonthly: Number(data.usage_monthly ?? 0),
    limit: data.limit ?? null,
    limitRemaining: data.limit_remaining ?? null,
    limitReset: data.limit_reset ?? null,
    label: data.label ?? null,
  };
}

export function parseCompletionUsage(raw: unknown): CompletionUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const promptTokens = Number(u.prompt_tokens ?? 0);
  const completionTokens = Number(u.completion_tokens ?? 0);
  const totalTokens = Number(u.total_tokens ?? promptTokens + completionTokens);
  const costUsd = typeof u.cost === "number" ? u.cost : undefined;
  if (!promptTokens && !completionTokens && costUsd === undefined) return undefined;
  return { promptTokens, completionTokens, totalTokens, costUsd };
}
