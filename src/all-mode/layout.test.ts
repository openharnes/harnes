import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemorySessionManager } from "../session-manager/manager.ts";
import {
  ALL_MODE_MIN_TERM_ROWS,
  ALL_MODE_MIN_TERM_WIDTH,
  ensureSessionCount,
  PaneTranscriptStore,
} from "./contract.ts";
import { canEnterAllMode, formatAllModeGrid, formatPaneLines } from "./layout.ts";

describe("all-mode layout (tied to Slice A SessionManager)", () => {
  it("refuses All mode on a small terminal", () => {
    const gate = canEnterAllMode(80, 20);
    assert.equal(gate.ok, false);
  });

  it("renders a 2x2 grid with focused mark and empty slots", () => {
    const mgr = new InMemorySessionManager({ persistDir: "/tmp/harnes-all-mode-test-unused" });
    const a = mgr.create({ title: "auth-api", cwd: "/tmp/a", pinnedModelId: "anthropic/claude-sonnet-4.5" });
    const b = mgr.create({ title: "sign-in-ui", cwd: "/tmp/b", pinnedModelId: "openai/gpt-5" });
    mgr.setStatus(b.id, "running");
    const transcripts = {
      [a.id]: ["→ read_file src/auth.ts"],
      [b.id]: ["Cooking…"],
    };
    const grid = formatAllModeGrid({
      sessions: [a, b, null, null],
      transcripts,
      focusedId: b.id,
      termWidth: Math.max(ALL_MODE_MIN_TERM_WIDTH, 120),
      termRows: Math.max(ALL_MODE_MIN_TERM_ROWS, 40),
      hostLabel: "local",
    });
    assert.equal(grid.ok, true);
    if (!grid.ok) return;
    const text = grid.lines.join("\n");
    assert.match(text, /All mode/);
    assert.match(text, /▸/);
    assert.match(text, /sign-in-ui|gpt-5|Cooking/);
    assert.match(text, /empty — \/pane/);
    assert.ok(grid.paneWidth >= 40);
  });

  it("formatPaneLines pads to exact width/height", () => {
    const mgr = new InMemorySessionManager({ persistDir: "/tmp/x" });
    const s = mgr.create({ title: "t", cwd: "/tmp" });
    const lines = formatPaneLines(s, {
      width: 40,
      height: 10,
      slot: 1,
      focused: true,
      accent: "orange",
      hostLabel: "local",
      transcript: ["hello"],
    });
    assert.equal(lines.length, 10);
    assert.ok(lines.every((l) => l.length === 40));
  });
});

describe("ensureSessionCount + PaneTranscriptStore", () => {
  it("fills up to 4 sessions on the real manager", () => {
    const mgr = new InMemorySessionManager({ persistDir: "/tmp/harnes-ensure" });
    assert.equal(mgr.list().length, 0);
    const four = ensureSessionCount(mgr, 4, "/tmp");
    assert.equal(four.length, 4);
    assert.equal(mgr.list().length, 4);
  });

  it("caps transcript lines per session", () => {
    const store = new PaneTranscriptStore();
    for (let i = 0; i < 50; i += 1) store.append("s1", `line ${i}`, 10);
    assert.equal(store.get("s1").length, 10);
    assert.equal(store.get("s1")[0], "line 40");
  });
});
