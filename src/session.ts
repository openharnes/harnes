import { execFileSync } from "node:child_process";
import type { HarnesConfig } from "./config.ts";
import { resolveChatEndpoint } from "./config.ts";
import type { ChatMessage } from "./loop.ts";
import {
  SESSION_MODE_LABELS,
  normalizeSessionMode,
  permissionForSessionMode,
  type PermissionMode,
  type SessionMode,
} from "./exec/types.ts";
import { getModel, wireModelId, type ModelSpec } from "./models/catalog.ts";
import { inferRouteKind, routeTask } from "./models/router.ts";
import { type TodoItem } from "./todos.ts";

export type { SessionMode } from "./exec/types.ts";
export {
  SESSION_MODES,
  SESSION_MODE_LABELS,
  cycleSessionMode,
  normalizeSessionMode,
} from "./exec/types.ts";

export interface SessionUsage {
  turns: number;
  agentSteps: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ActiveSession {
  mode: SessionMode;
  permissionMode: PermissionMode;
  modeLabel: string;
  model: ModelSpec;
  wireId: string;
  routing: "auto" | "pinned";
  tokensUsed: number;
  contextWindow: number;
}

/** @deprecated use permissionForSessionMode — kept for tests / call sites */
export function permissionForSession(mode: SessionMode, _prompt?: string): PermissionMode {
  return permissionForSessionMode(mode);
}

export function resolveActiveModel(config: HarnesConfig, prompt?: string): {
  model: ModelSpec;
  routing: "auto" | "pinned";
} {
  if (config.pinnedModelId) {
    try {
      return { model: getModel(config.pinnedModelId), routing: "pinned" };
    } catch {
      // Stale / typo'd pin (e.g. "~provider/slug") — fall back to auto rather than crash startup.
    }
  }
  const kind = prompt ? inferRouteKind(prompt) : "build";
  return { model: routeTask(kind, config.router), routing: "auto" };
}

/** Rough token estimate: UTF-8 bytes / 4, matching common CLI status bars. */
export function estimateTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  return Math.max(0, Math.ceil(chars / 4));
}

export function formatTokenBar(used: number, window: number): string {
  if (window <= 0) return `${used}`;
  const pct = Math.min(100, Math.round((used / window) * 100));
  return `${used.toLocaleString()} / ${window.toLocaleString()} (${pct}%)`;
}

export function formatCtxPct(used: number, window: number): string {
  if (window <= 0) return `${used}`;
  const pct = Math.min(100, Math.round((used / window) * 100));
  return `${pct}%`;
}

export function resolveSession(
  config: HarnesConfig,
  history: ChatMessage[],
  prompt?: string
): ActiveSession {
  const mode = normalizeSessionMode(config.sessionMode);
  const { model, routing } = resolveActiveModel(config, prompt);
  const endpoint = resolveChatEndpoint(config);
  return {
    mode,
    permissionMode: permissionForSessionMode(mode),
    modeLabel: SESSION_MODE_LABELS[mode],
    model,
    wireId: wireModelId(model, endpoint.provider),
    routing,
    tokensUsed: estimateTokens(history),
    contextWindow: model.minContext,
  };
}

export function formatStatusLine(session: ActiveSession, extra?: { cwd?: string; provider?: string }): string {
  const pin = session.routing === "pinned" ? "pinned" : "auto-route";
  const parts = [
    `model ${session.model.name}`,
    `mode ${session.modeLabel}`,
    `ctx ${formatTokenBar(session.tokensUsed, session.contextWindow)}`,
    pin,
  ];
  if (extra?.provider) parts.push(extra.provider);
  return parts.join(" · ");
}

export interface FooterChrome {
  /** Full-width rule under the input. */
  separator: string;
  /** Mode / hints on the left, model + cost on the right. */
  status: string;
  /** Logo + mode + path + branch chips. */
  bar: string;
}

function visibleWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad left and right segments across `width` columns (ANSI-safe). */
export function splitStatusLine(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  if (visibleWidth(left) + 1 + visibleWidth(right) > width) {
    const maxLeft = Math.max(8, width - visibleWidth(right) - 1);
    const plain = left.replace(/\x1b\[[0-9;]*m/g, "");
    const trimmed = plain.length > maxLeft ? `${plain.slice(0, Math.max(0, maxLeft - 1))}…` : plain;
    const g = Math.max(1, width - visibleWidth(trimmed) - visibleWidth(right));
    return `${trimmed}${" ".repeat(g)}${right}`;
  }
  return `${left}${" ".repeat(gap)}${right}`;
}

export function shortPath(cwd: string, home = process.env.HOME ?? ""): string {
  if (home && cwd === home) return "~";
  if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

/** Cached git branch lookup (empty string when not a repo). */
const branchCache = new Map<string, { at: number; branch: string }>();

export function gitBranch(cwd: string, now = Date.now()): string {
  const hit = branchCache.get(cwd);
  if (hit && now - hit.at < 5_000) return hit.branch;
  let branch = "";
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 400,
    }).trim();
    if (branch === "HEAD") branch = "detached";
  } catch {
    branch = "";
  }
  branchCache.set(cwd, { at: now, branch });
  return branch;
}

/**
 * Copilot / Cursor-style chrome:
 * full-width rule, single status row (hints left · model right), bottom bar with logo + path + branch.
 */
export function formatFooterChrome(opts: {
  session: ActiveSession;
  cwd: string;
  width: number;
  costUsd?: number;
  lastDone?: string;
  branch?: string;
}): FooterChrome {
  const { session, cwd, width } = opts;
  const costUsd = opts.costUsd ?? 0;
  const branch = opts.branch ?? gitBranch(cwd);
  const w = Math.max(40, width);

  const cost = costUsd > 0 ? formatCostShort(costUsd) : "";
  const rightParts = [
    session.model.name,
    formatCtxPct(session.tokensUsed, session.contextWindow),
    cost || undefined,
    opts.lastDone,
  ].filter(Boolean) as string[];

  const left = `${session.modeLabel} · ⌃T cycle · /help`;
  const right = rightParts.join(" · ");

  const path = shortPath(cwd);
  // Chip-style bottom strip: logo · mode · path · branch
  const chips = [`◆ Harnes`, session.modeLabel, path, branch || undefined].filter(Boolean) as string[];
  const barLeft = chips.join("   ");
  const barRight = session.routing === "pinned" ? "pinned" : "/mode";

  return {
    separator: "─".repeat(w),
    status: splitStatusLine(left, right, w),
    bar: splitStatusLine(barLeft, barRight, w),
  };
}

/**
 * @deprecated Prefer formatFooterChrome.
 * Returns [status, bar] — model cluster is on the right of status.
 */
export function formatFooterLines(
  session: ActiveSession,
  costUsd = 0,
  lastDone?: string,
  cwd = process.cwd(),
  width = 80
): [string, string] {
  const chrome = formatFooterChrome({ session, cwd, width, costUsd, lastDone });
  return [chrome.status, chrome.bar];
}

/** @deprecated single-line form; prefer formatFooterChrome */
export function formatFooterStatus(session: ActiveSession): string {
  const [a, b] = formatFooterLines(session);
  return `${a}  ${b}`;
}

/** `$0.27` style short-money, matching the footer's existing precision rules. */
export function formatCostShort(costUsd: number): string {
  if (costUsd <= 0) return "$0.00";
  return `$${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`;
}

// --- Right-hand sidebar (Task / Context / MCP / LSP / Todo) ----------------

/** Below this terminal width the sidebar doesn't fit without crushing the transcript; fall back to footer-only chrome. */
export const SIDEBAR_MIN_TERM_WIDTH = 100;
const SIDEBAR_WIDTH_MIN = 28;
const SIDEBAR_WIDTH_MAX = 36;

/** Right-rail column width for a given terminal width, clamped to the ~28–36 col target. */
export function sidebarWidthFor(termWidth: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.floor(termWidth * 0.28)));
}

export interface SidebarMcpEntry {
  name: string;
  connected: boolean;
  detail?: string;
}

export interface SidebarData {
  taskTitle: string;
  tokensUsed: number;
  contextWindow: number;
  costUsd: number;
  mcp: SidebarMcpEntry[];
  /** Detected LSP servers; always empty until Harnes wires a real client (see docs/lsp-plan.md). */
  lsp: string[];
  todos: TodoItem[];
}

/**
 * Picks the sidebar's "Task" title: the first in-progress todo, else the
 * first pending one, else the most recent user prompt — first line only,
 * truncated so it never wraps the whole rail.
 */
export function deriveTaskTitle(todos: TodoItem[], fallbackPrompt = "", max = 60): string {
  const active = todos.find((item) => item.status === "in_progress") ?? todos.find((item) => item.status === "pending");
  const raw = (active?.content ?? fallbackPrompt).trim();
  const line = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > width && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [text.slice(0, width)];
}

export type SidebarLineKind = "title" | "header" | "body" | "muted" | "ok" | "blank";

export interface SidebarLine {
  text: string;
  kind: SidebarLineKind;
}

/** Sidebar todo lines match the screenshot: `[ ] content` (no id numbers). */
export function formatSidebarTodoLines(items: TodoItem[]): string[] {
  if (items.length === 0) return [];
  const mark: Record<TodoItem["status"], string> = {
    pending: "[ ]",
    in_progress: "[~]",
    completed: "[x]",
  };
  return items.map((item) => `${mark[item.status]} ${item.content}`);
}

/**
 * Renders the sidebar's plain-text content (no ANSI) top to bottom: Task,
 * Context (tokens / % used / spend), MCP (per-server connection dot),
 * ▼ LSP, ▼ Todo. The caller paints colors per `kind` and places each line
 * in the right rail — kept ANSI-free here so it's unit-testable.
 */
export function formatSidebarLines(data: SidebarData, width: number): SidebarLine[] {
  const w = Math.max(16, width);
  const lines: SidebarLine[] = [];
  const push = (text: string, kind: SidebarLineKind = "body") => lines.push({ text, kind });

  const title = data.taskTitle || "Idle — waiting for a task";
  for (const l of wrapToWidth(title, w)) push(l, "title");
  push("", "blank");

  push("Context", "header");
  push(`${data.tokensUsed.toLocaleString()} tokens`);
  push(`${formatCtxPct(data.tokensUsed, data.contextWindow)} used`);
  push(`${formatCostShort(data.costUsd)} spent`);
  push("", "blank");

  push("MCP", "header");
  if (data.mcp.length === 0) {
    push("(none configured)", "muted");
  } else {
    for (const server of data.mcp) {
      const mark = server.connected ? "●" : "○";
      const label = server.connected ? "Connected" : server.detail || "offline";
      for (const l of wrapToWidth(`${mark} ${server.name} ${label}`, w)) {
        push(l, server.connected ? "ok" : "muted");
      }
    }
  }
  push("", "blank");

  // Not wired up yet — Harnes has no LSP client (see docs/lsp-plan.md). Never
  // invent servers; this stays a stub until a real client lands.
  push("▼ LSP", "header");
  if (data.lsp.length === 0) {
    push("(none)", "muted");
  } else {
    for (const server of data.lsp) for (const l of wrapToWidth(server, w)) push(l);
  }
  push("", "blank");

  push("▼ Todo", "header");
  const todoLines = formatSidebarTodoLines(data.todos);
  if (todoLines.length === 0) {
    push("(no todos yet)", "muted");
  } else {
    for (const line of todoLines) for (const l of wrapToWidth(line, w)) push(l);
  }

  return lines;
}
