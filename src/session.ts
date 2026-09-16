import type { HarnesConfig } from "./config.ts";
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
import { resolveChatEndpoint } from "./config.ts";

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

/** Two-line footer under the input (WOZ-style). */
export function formatFooterLines(session: ActiveSession, costUsd = 0): [string, string] {
  const route = session.routing === "pinned" ? "pinned" : "auto";
  const cost = costUsd > 0 ? `  ·  $${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)} sess` : "";
  return [
    `→ ${session.model.name}  ${session.wireId}  ·  ctx ${formatTokenBar(session.tokensUsed, session.contextWindow)}${cost}`,
    `» ${session.modeLabel}  ·  ${route}  ·  ⇧Tab cycle  ·  /usage · /help`,
  ];
}

/** @deprecated single-line form; prefer formatFooterLines */
export function formatFooterStatus(session: ActiveSession): string {
  const [a, b] = formatFooterLines(session);
  return `${a}  ${b}`;
}
