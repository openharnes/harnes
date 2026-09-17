import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type HarnesConfig } from "../config.ts";
import { InMemorySessionManager } from "./manager.ts";
import {
  resolveSessionActiveModel,
  resolveSessionState,
  setSessionMode,
  setSessionModel,
} from "./session-model.ts";

const config: HarnesConfig = { ...DEFAULT_CONFIG, provider: "ollama" };

test("resolveSessionActiveModel: unpinned session falls back to auto routing", () => {
  const mgr = new InMemorySessionManager();
  const session = mgr.create({ title: "S1" });
  const { model, routing } = resolveSessionActiveModel(session, config);
  assert.equal(routing, "auto");
  assert.ok(model.id);
});

test("resolveSessionActiveModel: pinned session resolves to that model", () => {
  const mgr = new InMemorySessionManager();
  const session = mgr.create({ title: "S1", pinnedModelId: "qwen3-coder-30b" });
  const { model, routing } = resolveSessionActiveModel(session, config);
  assert.equal(routing, "pinned");
  assert.equal(model.id, "qwen3-coder-30b");
});

test("resolveSessionActiveModel: stale/unknown pin falls back to auto instead of throwing", () => {
  const mgr = new InMemorySessionManager();
  const session = mgr.create({ title: "S1", pinnedModelId: "~totally/unknown-model" });
  const { routing } = resolveSessionActiveModel(session, config);
  assert.equal(routing, "auto");
});

test("two new sessions with different pins resolve to different models independently", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "A", pinnedModelId: "qwen3-coder-30b" });
  const b = mgr.create({ title: "B", pinnedModelId: "claude-sonnet" });

  const resolvedA = resolveSessionActiveModel(a, config);
  const resolvedB = resolveSessionActiveModel(b, config);

  assert.equal(resolvedA.model.id, "qwen3-coder-30b");
  assert.equal(resolvedB.model.id, "claude-sonnet");
  assert.notEqual(resolvedA.model.id, resolvedB.model.id);
});

test("session pins are independent of the global config.pinnedModelId", () => {
  const globalConfig: HarnesConfig = { ...DEFAULT_CONFIG, pinnedModelId: "claude-sonnet" };
  const mgr = new InMemorySessionManager();
  const session = mgr.create({ title: "S1", pinnedModelId: "qwen3-coder-30b" });

  const { model, routing } = resolveSessionActiveModel(session, globalConfig);
  assert.equal(routing, "pinned");
  assert.equal(model.id, "qwen3-coder-30b", "session pin must win over global config.pinnedModelId");
});

test("resolveSessionState mirrors resolveSession's shape, scoped to the session", () => {
  const mgr = new InMemorySessionManager();
  const session = mgr.create({ title: "S1", pinnedModelId: "qwen3-coder-30b", sessionMode: "plan" });
  const state = resolveSessionState(session, config);

  assert.equal(state.mode, "plan");
  assert.equal(state.permissionMode, "plan");
  assert.equal(state.model.id, "qwen3-coder-30b");
  assert.equal(state.routing, "pinned");
  assert.equal(state.tokensUsed, 0);
  assert.equal(state.contextWindow, state.model.minContext);
  assert.ok(state.wireId);
});

test("setSessionModel: pins a valid model id and persists it on the session", () => {
  const mgr = new InMemorySessionManager();
  const session = mgr.create({ title: "S1" });

  const result = setSessionModel(mgr, session, "qwen3-coder-30b", config);
  assert.equal(result.ok, true);
  assert.equal(result.model?.id, "qwen3-coder-30b");
  assert.equal(mgr.get(session.id)?.pinnedModelId, result.pinnedModelId);
});

test("setSessionModel: 'auto' clears an existing pin", () => {
  const mgr = new InMemorySessionManager();
  const session = mgr.create({ title: "S1", pinnedModelId: "qwen3-coder-30b" });

  const result = setSessionModel(mgr, session, "auto", config);
  assert.equal(result.ok, true);
  assert.equal(mgr.get(session.id)?.pinnedModelId, undefined);
});

test("setSessionModel: invalid model id is rejected with a clear message and does not mutate the session", () => {
  const mgr = new InMemorySessionManager();
  const session = mgr.create({ title: "S1", pinnedModelId: "qwen3-coder-30b" });

  const result = setSessionModel(mgr, session, "totally-not-a-real-model", config);
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0);
  // Session must be untouched — still pinned to the original model.
  assert.equal(mgr.get(session.id)?.pinnedModelId, "qwen3-coder-30b");
});

test("setSessionModel: two sessions' pins stay independent of each other", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "A" });
  const b = mgr.create({ title: "B" });

  setSessionModel(mgr, a, "qwen3-coder-30b", config);
  setSessionModel(mgr, b, "claude-sonnet", config);

  assert.equal(mgr.get(a.id)?.pinnedModelId, "qwen3-coder-30b");
  assert.notEqual(mgr.get(a.id)?.pinnedModelId, mgr.get(b.id)?.pinnedModelId);
});

test("setSessionMode: accepts a valid alias and updates the session", () => {
  const mgr = new InMemorySessionManager();
  const session = mgr.create({ title: "S1" });

  const result = setSessionMode(mgr, session, "plan");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "plan");
  assert.equal(result.permissionMode, "plan");
  assert.equal(mgr.get(session.id)?.sessionMode, "plan");
});

test("setSessionMode: accepts known aliases (ask-on-edit, automatic, legacy build)", () => {
  const mgr = new InMemorySessionManager();
  const session = mgr.create({ title: "S1" });

  assert.equal(setSessionMode(mgr, session, "ask-on-edit").mode, "ask");
  assert.equal(setSessionMode(mgr, session, "automatic").mode, "auto");
  const legacy = setSessionMode(mgr, session, "build");
  assert.equal(legacy.mode, "auto");
  assert.equal(legacy.legacyBuildAlias, true);
});

test("setSessionMode: invalid mode string is rejected with a clear message and does not mutate the session", () => {
  const mgr = new InMemorySessionManager();
  const session = mgr.create({ title: "S1", sessionMode: "manual" });

  const result = setSessionMode(mgr, session, "not-a-real-mode");
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0);
  assert.equal(mgr.get(session.id)?.sessionMode, "manual");
});

test("setSessionMode: two sessions' modes stay independent of each other", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "A" });
  const b = mgr.create({ title: "B" });

  setSessionMode(mgr, a, "plan");
  setSessionMode(mgr, b, "manual");

  assert.equal(mgr.get(a.id)?.sessionMode, "plan");
  assert.equal(mgr.get(b.id)?.sessionMode, "manual");
});
