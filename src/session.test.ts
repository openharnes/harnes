import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "./config.ts";
import {
  estimateTokens,
  formatFooterLines,
  formatFooterStatus,
  formatTokenBar,
  permissionForSession,
  resolveActiveModel,
  resolveSession,
} from "./session.ts";

describe("session", () => {
  it("auto mode uses plan tools for explore prompts", () => {
    assert.equal(permissionForSession("auto", "explain this repo"), "plan");
    assert.equal(permissionForSession("auto", "add a retry policy"), "build");
    assert.equal(permissionForSession("plan", "add a retry policy"), "plan");
    assert.equal(permissionForSession("build", "explain this repo"), "build");
  });

  it("pins a model when pinnedModelId is set", () => {
    const pinned = resolveActiveModel({ ...DEFAULT_CONFIG, pinnedModelId: "claude-sonnet" }, "explain this repo");
    assert.equal(pinned.routing, "pinned");
    assert.equal(pinned.model.id, "claude-sonnet");
    const auto = resolveActiveModel({ ...DEFAULT_CONFIG, pinnedModelId: undefined }, "explain this repo");
    assert.equal(auto.routing, "auto");
    assert.equal(auto.model.tier, "fast-open");
  });

  it("estimates context against the model window", () => {
    const session = resolveSession(DEFAULT_CONFIG, [
      { role: "user", content: "a".repeat(400) },
      { role: "assistant", content: "b".repeat(400) },
    ]);
    assert.equal(session.tokensUsed, 200);
    assert.equal(session.contextWindow, session.model.minContext);
    assert.match(formatTokenBar(200, 32768), /200/);
  });

  it("counts message characters for tokens", () => {
    assert.equal(estimateTokens([{ role: "user", content: "abcd" }]), 1);
  });

  it("formats the bottom status strip", () => {
    const session = resolveSession(DEFAULT_CONFIG, []);
    const line = formatFooterStatus(session);
    assert.match(line, /^→ /);
    assert.match(line, / · /);
    assert.match(line, /ctx /);
    assert.match(line, /%/);
  });
});