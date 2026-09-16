import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatUsd, parseCompletionUsage, fetchOpenRouterKeyUsage } from "./usage.ts";

describe("openrouter usage", () => {
  it("formats small USD amounts", () => {
    assert.equal(formatUsd(0), "$0.00");
    assert.match(formatUsd(0.00012), /\$0\.000120/);
    assert.match(formatUsd(0.0421), /\$0\.0421/);
  });

  it("parses completion usage including cost", () => {
    const usage = parseCompletionUsage({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      cost: 0.00014,
    });
    assert.deepEqual(usage, {
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      costUsd: 0.00014,
    });
  });

  it("fetches key usage from OpenRouter", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            usage: 25.5,
            usage_daily: 1.2,
            usage_weekly: 5.5,
            usage_monthly: 25.5,
            limit: 100,
            limit_remaining: 74.5,
            limit_reset: "monthly",
            label: "sk-or-v1-au7...890",
          },
        }),
        { status: 200 }
      );
    const usage = await fetchOpenRouterKeyUsage("sk-test", fetchImpl);
    assert.equal(usage.usageMonthly, 25.5);
    assert.equal(usage.usageDaily, 1.2);
    assert.equal(usage.limitRemaining, 74.5);
  });
});
