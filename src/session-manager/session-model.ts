/**
 * Slice A — Agent A4: model / mode resolution and mutation scoped to a
 * single `HarnesSession`, instead of the single global `HarnesConfig`.
 *
 * `src/session.ts`'s `resolveActiveModel` / `resolveSession` read
 * `config.pinnedModelId` / `config.sessionMode` off one global config. Once
 * sessions exist, each session carries its own `pinnedModelId` /
 * `sessionMode` (see `HarnesSession` in ./types.ts) and those — not the
 * global config — should drive `/model` and `/mode`. This module mirrors
 * that logic against a session instead of modifying session.ts's existing
 * exports (per the brief: don't change session.ts's existing signatures;
 * only import from it).
 *
 * Agent A3 wires these into src/repl.ts; this module does not touch the
 * REPL or do any I/O beyond calling `SessionManager.update`.
 */

import { resolveChatEndpoint, type HarnesConfig } from "../config.ts";
import {
  SESSION_MODE_LABELS,
  normalizeSessionMode,
  permissionForSessionMode,
  type PermissionMode,
  type SessionMode,
} from "../exec/types.ts";
import { getModel, normalizeModelId, wireModelId, type ModelSpec } from "../models/catalog.ts";
import { inferRouteKind, routeTask } from "../models/router.ts";
import { estimateTokens, type ActiveSession } from "../session.ts";
import type { SessionManager } from "./types.ts";
import type { HarnesSession } from "./types.ts";

export interface SessionActiveModel {
  model: ModelSpec;
  routing: "auto" | "pinned";
}

/**
 * Same routing logic as `resolveActiveModel` in session.ts, but reads
 * `session.pinnedModelId` instead of `config.pinnedModelId`. `config` is
 * still needed for the auto-router (`config.router`).
 */
export function resolveSessionActiveModel(
  session: HarnesSession,
  config: HarnesConfig,
  prompt?: string
): SessionActiveModel {
  if (session.pinnedModelId) {
    try {
      return { model: getModel(session.pinnedModelId), routing: "pinned" };
    } catch {
      // Stale / typo'd pin — fall back to auto rather than crash the turn.
    }
  }
  const kind = prompt ? inferRouteKind(prompt) : "build";
  return { model: routeTask(kind, config.router), routing: "auto" };
}

/**
 * `resolveSession` (session.ts) scoped to a `HarnesSession` instead of the
 * global config: mode / model / tokensUsed / contextWindow / wireId, all
 * computed from the session's own fields. `config` supplies only
 * provider-level settings that aren't (yet) per-session — the chat
 * endpoint/provider used to pick the wire model id, and the auto-router.
 */
export function resolveSessionState(session: HarnesSession, config: HarnesConfig, prompt?: string): ActiveSession {
  const mode = normalizeSessionMode(session.sessionMode);
  const { model, routing } = resolveSessionActiveModel(session, config, prompt);
  const endpoint = resolveChatEndpoint(config);
  return {
    mode,
    permissionMode: permissionForSessionMode(mode),
    modeLabel: SESSION_MODE_LABELS[mode],
    model,
    wireId: wireModelId(model, endpoint.provider),
    routing,
    tokensUsed: estimateTokens(session.history),
    contextWindow: model.minContext,
  };
}

export interface SetSessionModelResult {
  ok: boolean;
  /** Present when ok is true. */
  model?: ModelSpec;
  /** Present when ok is true and the pin was set (not cleared to auto). */
  pinnedModelId?: string;
  /** Present when ok is false — safe to print directly to the user. */
  error?: string;
  session: HarnesSession;
}

/**
 * Validates and sets (or clears) a session's model pin. Mirrors
 * `setModel`'s validation in repl.ts (`getModel(normalizeModelId(arg))`)
 * without any of the REPL's I/O (OpenRouter catalog refresh, console
 * logging) — A3 is expected to do that around this call if it wants it.
 *
 * `"auto"` clears the pin (routes automatically). An unknown/invalid model
 * id returns `{ ok: false, error }` and does NOT call `sessionManager.update`
 * — the session is left untouched rather than thrown into an inconsistent
 * state.
 */
export function setSessionModel(
  sessionManager: SessionManager,
  session: HarnesSession,
  modelIdOrAuto: string,
  config: HarnesConfig
): SetSessionModelResult {
  const arg = modelIdOrAuto.trim();
  if (arg.toLowerCase() === "auto") {
    const updated = sessionManager.update(session.id, { pinnedModelId: undefined });
    return { ok: true, session: updated };
  }
  let model: ModelSpec;
  try {
    model = getModel(normalizeModelId(arg));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      session,
    };
  }
  let pinId = model.id;
  try {
    const endpoint = resolveChatEndpoint(config);
    pinId = endpoint.provider === "openrouter" ? (model.openrouterModel ?? model.id) : model.id;
  } catch {
    // Fall back to the catalog id if endpoint resolution fails for any reason.
  }
  const updated = sessionManager.update(session.id, { pinnedModelId: pinId });
  return { ok: true, model, pinnedModelId: pinId, session: updated };
}

export interface SetSessionModeResult {
  ok: boolean;
  mode?: SessionMode;
  permissionMode?: PermissionMode;
  /** Present when ok is false — safe to print directly to the user. */
  error?: string;
  /** True when the accepted alias was the legacy "build" spelling — caller may want to note this. */
  legacyBuildAlias?: boolean;
  session: HarnesSession;
}

/**
 * The exact alias set `/mode` accepts today in repl.ts's `handleSlash`
 * ("mode" case) — kept in sync here rather than re-derived, per the task
 * brief ("mirror it, don't invent new rules").
 */
const MODE_ALIASES = new Set(["auto", "automatic", "manual", "ask", "ask-on-edit", "plan", "build"]);

/**
 * Validates and sets a session's `sessionMode`. Mirrors the validation in
 * repl.ts's `/mode` handler: accepts the same alias set, rejects anything
 * else with a clear usage message, and does NOT mutate the session on an
 * invalid value.
 */
export function setSessionMode(
  sessionManager: SessionManager,
  session: HarnesSession,
  arg: string
): SetSessionModeResult {
  const raw = arg.trim().toLowerCase();
  if (!MODE_ALIASES.has(raw)) {
    return {
      ok: false,
      error: "Usage: /mode auto|manual|ask|plan   (or ⌃T / ⇧Tab)",
      session,
    };
  }
  const mode = normalizeSessionMode(raw);
  const updated = sessionManager.update(session.id, { sessionMode: mode });
  return {
    ok: true,
    mode,
    permissionMode: permissionForSessionMode(mode),
    legacyBuildAlias: raw === "build",
    session: updated,
  };
}
