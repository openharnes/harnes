import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "./config.ts";
import {
  deriveTaskTitle,
  estimateTokens,
  formatCostShort,
  formatFooterChrome,
  formatFooterLines,
  formatFooterStatus,
  formatSidebarLines,
  formatTokenBar,
  normalizeSessionMode,
  permissionForSession,
  resolveActiveModel,
  resolveSession,
  cycleSessionMode,
  sidebarWidthFor,
  SIDEBAR_MIN_TERM_WIDTH,
  splitStatusLine,
  shortPath,
  type SidebarData,
} from "./session.ts";
import { needsApproval } from "./exec/types.ts";
import type { TodoItem } from "./todos.ts";

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

  it("formats Copilot-style chrome with model on the right", () => {
    const session = resolveSession(DEFAULT_CONFIG, []);
    const chrome = formatFooterChrome({
      session,
      cwd: "/Users/demo/Code/OpenHarnes",
      width: 80,
      costUsd: 0.0021,
      branch: "main",
    });
    assert.equal(chrome.separator.length, 80);
    assert.match(chrome.status, /^ask on edit/);
    assert.match(chrome.status, /Qwen3/);
    assert.ok(chrome.status.indexOf("ask on edit") < chrome.status.indexOf("Qwen3"));
    assert.match(chrome.bar, /◆ Harnes/);
    assert.match(chrome.bar, /ask on edit|automatic|manual|plan/);
    assert.match(chrome.bar, /main/);
    assert.equal(shortPath("/Users/demo/Code/OpenHarnes", "/Users/demo"), "~/Code/OpenHarnes");
    const [status, bar] = formatFooterLines(session, 0, undefined, "/tmp", 60);
    assert.match(status, /⌃T cycle/);
    assert.match(bar, /◆ Harnes/);
    assert.match(formatFooterStatus(session), /⌃T cycle/);
  });

  it("splits status lines to the far edges", () => {
    const line = splitStatusLine("left", "right", 20);
    assert.equal(line.length, 20);
    assert.ok(line.startsWith("left"));
    assert.ok(line.endsWith("right"));
  });
});

describe("sidebar", () => {
  const todos: TodoItem[] = [
    { id: "1", content: "Create migration to add date_of_birth column", status: "completed" },
    { id: "2", content: "Update User model with date_of_birth", status: "in_progress" },
    { id: "3", content: "Update registration tests", status: "pending" },
  ];

  it("picks the first in-progress todo as the task title, else pending, else the prompt", () => {
    assert.equal(deriveTaskTitle(todos), "Update User model with date_of_birth");
    assert.equal(
      deriveTaskTitle(todos.filter((t) => t.status !== "in_progress")),
      "Update registration tests"
    );
    assert.equal(deriveTaskTitle([], "explain this repo"), "explain this repo");
    assert.equal(deriveTaskTitle([], ""), "");
  });

  it("truncates a long task title instead of wrapping the whole rail", () => {
    const long = "x".repeat(80);
    const title = deriveTaskTitle([], long, 20);
    assert.equal(title.length, 20);
    assert.ok(title.endsWith("…"));
  });

  it("formats short money consistently", () => {
    assert.equal(formatCostShort(0), "$0.00");
    assert.equal(formatCostShort(0.0021), "$0.0021");
    assert.equal(formatCostShort(0.27), "$0.27");
  });

  it("clamps sidebar width to the ~28-36 col target and falls back below the min terminal width", () => {
    assert.equal(sidebarWidthFor(200), 36);
    assert.equal(sidebarWidthFor(100), 28);
    assert.ok(sidebarWidthFor(80) >= 28);
    assert.equal(SIDEBAR_MIN_TERM_WIDTH, 100);
  });

  it("renders Task / Context / MCP / LSP / Todo sections in order", () => {
    const data: SidebarData = {
      taskTitle: "Implementing signup age-validate field",
      tokensUsed: 28814,
      contextWindow: 200000,
      costUsd: 0.27,
      mcp: [
        { name: "herd", connected: true },
        { name: "laravel-boost", connected: false, detail: "offline" },
      ],
      lsp: [],
      todos,
    };
    const lines = formatSidebarLines(data, 32).map((l) => l.text);
    const text = lines.join("\n");

    assert.equal(lines[0], "Implementing signup age-validate");
    assert.match(text, /28,814 tokens/);
    assert.match(text, /14% used/);
    assert.match(text, /\$0\.27 spent/);
    assert.match(text, /● herd Connected/);
    assert.match(text, /○ laravel-boost offline/);
    assert.match(text, /▼ LSP/);
    assert.match(text, /\(none\)/);
    assert.match(text, /▼ Todo/);
    assert.match(text, /\[x\] Create migration/);
    assert.match(text, /\[~\] Update User model/);
    assert.match(text, /\[ \] Update registration tests/);
    assert.doesNotMatch(text, /\[x\] 1\./);
    // Context always precedes MCP, which always precedes LSP, which always precedes Todo.
    assert.ok(text.indexOf("Context") < text.indexOf("MCP"));
    assert.ok(text.indexOf("MCP") < text.indexOf("▼ LSP"));
    assert.ok(text.indexOf("▼ LSP") < text.indexOf("▼ Todo"));
  });

  it("never invents MCP/LSP entries when none are configured", () => {
    const data: SidebarData = {
      taskTitle: "",
      tokensUsed: 0,
      contextWindow: 32768,
      costUsd: 0,
      mcp: [],
      lsp: [],
      todos: [],
    };
    const text = formatSidebarLines(data, 32)
      .map((l) => l.text)
      .join("\n");
    assert.match(text, /\(none configured\)/);
    assert.match(text, /\(no todos yet\)/);
    assert.match(text, /Idle — waiting for a task/);
  });
});
