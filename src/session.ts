import type { HarnesConfig } from "./config.ts";
import type { ChatMessage } from "./loop.ts";
import type { PermissionMode, SessionMode } from "./exec/types.ts";
import { getModel, wireModelId, type ModelSpec } from "./models/catalog.ts";
import { inferRouteKind, routeTask } from "./models/router.ts";
import { resolveChatEndpoint } from "./config.ts";

export type { SessionMode } from "./exec/types.ts";

export interface SessionUsage {
  turns: number;
  agentSteps: number;
  toolCalls: number;
}

export interface ActiveSession {
  mode: SessionMode;
  permissionMode: PermissionMode;
  model: ModelSpec;
  wireId: string;
  routing: "auto" | "pinned";
  tokensUsed: number;
  contextWindow: number;
}

export function normalizeSessionMode(value: string | undefined): SessionMode {
  if (value === "plan" || value === "build" || value === "auto") return value;
  return "auto";
}

export function permissionForSession(mode: SessionMode, prompt?: string): PermissionMode {
  if (mode === "plan") return "plan";
  if (mode === "build") return "build";
  if (!prompt) return "build";
  const kind = inferRouteKind(prompt);
  return kind === "explore" || kind === "compact" ? "plan" : "build";
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
    permissionMode: permissionForSession(mode, prompt),
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
    `mode ${session.mode}`,
    `tools ${session.permissionMode}`,
    `ctx ${formatTokenBar(session.tokensUsed, session.contextWindow)}`,
    pin,
  ];
  if (extra?.provider) parts.push(extra.provider);
  return parts.join(" · ");
}

/** Two-line footer under the input (WOZ-style). */
export function formatFooterLines(session: ActiveSession): [string, string] {
  const route = session.routing === "pinned" ? "pinned" : "auto";
  return [
    `→ ${session.model.name}  ${session.wireId}  ·  ctx ${formatTokenBar(session.tokensUsed, session.contextWindow)}`,
    `» ${session.mode}/${session.permissionMode}  ·  ${route}  ·  /help`,
  ];
}

/** @deprecated single-line form; prefer formatFooterLines */
export function formatFooterStatus(session: ActiveSession): string {
  const [a, b] = formatFooterLines(session);
  return `${a}  ${b}`;
}
