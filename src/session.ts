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
  /** Logo + explorer + path + branch chips. */
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

  const cost =
    costUsd > 0 ? `$${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}` : "";
  const rightParts = [
    session.model.name,
    formatCtxPct(session.tokensUsed, session.contextWindow),
    cost || undefined,
    opts.lastDone,
  ].filter(Boolean) as string[];

  const left = `${session.modeLabel} · ⌃T cycle · /help`;
  const right = rightParts.join(" · ");

  const path = shortPath(cwd);
  // Chip-style bottom strip: logo · explorer · path · branch (Copilot / Cursor vibe)
  const chips = [`◆ Harnes`, `explorer`, path, branch || undefined].filter(Boolean) as string[];
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
