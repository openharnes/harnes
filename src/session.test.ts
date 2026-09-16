import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "./config.ts";
import {
  estimateTokens,
  formatFooterLines,
  formatFooterStatus,
  formatTokenBar,
  normalizeSessionMode,
  permissionForSession,
  resolveActiveModel,
  resolveSession,
  cycleSessionMode,
} from "./session.ts";
import { needsApproval } from "./exec/types.ts";

describe("session", () => {
  it("maps session modes onto tool surfaces", () => {
    assert.equal(permissionForSession("plan"), "plan");
    assert.equal(permissionForSession("auto"), "build");
    assert.equal(permissionForSession("manual"), "build");
    assert.equal(permissionForSession("ask"), "build");
  });

  it("normalizes legacy and alias mode names", () => {
    assert.equal(normalizeSessionMode("build"), "auto");
    assert.equal(normalizeSessionMode("automatic"), "auto");
    assert.equal(normalizeSessionMode("ask-on-edit"), "ask");
    assert.equal(normalizeSessionMode("nope"), "ask");
  });

  it("cycles Shift+Tab order: auto → manual → ask → plan", () => {
    assert.equal(cycleSessionMode("auto"), "manual");
    assert.equal(cycleSessionMode("manual"), "ask");
    assert.equal(cycleSessionMode("ask"), "plan");
    assert.equal(cycleSessionMode("plan"), "auto");
  });

  it("asks for approval only when the mode requires it", () => {
    assert.equal(needsApproval("auto", "bash"), false);
    assert.equal(needsApproval("manual", "read_file"), true);
    assert.equal(needsApproval("ask", "read_file"), false);
    assert.equal(needsApproval("ask", "write_file"), true);
    assert.equal(needsApproval("ask", "bash"), true);
    assert.equal(needsApproval("plan", "bash"), false);
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

  it("formats the bottom status strip with mode label", () => {
    const session = resolveSession(DEFAULT_CONFIG, []);
    const [line1, line2] = formatFooterLines(session);
    assert.match(line1, /^→ /);
    assert.match(line2, /ask on edit|automatic|manual|plan/);
    assert.match(line2, /⌃T\/⇧Tab/);
    assert.match(formatFooterStatus(session), /ctx /);
  });
});
