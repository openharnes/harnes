/**
 * Slice A — Agent A5: per-session running status + abort.
 *
 * Wraps the bookkeeping that today lives inline in `src/repl.ts`'s
 * `runTurn` (see that function's `turnBusy` flag and its single module-level
 * `turnAbort: AbortController`) so it can be done **per session** instead of
 * once globally. This module does not call `runAgentLoop` itself and does
 * not touch `src/repl.ts` — Agent A3 calls `startSessionTurn` /
 * `finishSessionTurn` / `abortSessionTurn` from wherever it ends up driving
 * a focused session's turn.
 *
 * ## Abort registry
 *
 * `AbortController` is not JSON-serializable and must never round-trip
 * through `SessionManager.save()`/`load()` (see persist.ts), so it is never
 * stored on `HarnesSession` itself. Instead it lives in a small
 * `SessionAbortRegistry` — a `Map<sessionId, AbortController>` wrapped in a
 * class — that A3 constructs once at REPL startup and holds alongside the
 * `SessionManager` (they are two separate objects with the same lifetime,
 * not one merged into the other).
 *
 * ## Status lifecycle
 *
 * `startSessionTurn` flips `session.status` to `"running"`.
 * `finishSessionTurn` flips it back to `"idle"` (success) or `"error"` +
 * `lastError` (failure) via `SessionManager.setStatus` (added by this agent
 * — see types.ts/manager.ts). Nothing here reacts to focus changes: an
 * unfocused session mid-turn keeps running exactly as before, because
 * abort only ever happens via an explicit `abortSessionTurn(registry, id)`
 * call, never as a side effect of `SessionManager.focus()`.
 */

import type { HarnesSession, SessionManager } from "./types.ts";

/**
 * Holds one `AbortController` per in-flight session turn. Not part of
 * `HarnesSession` / `SessionManager` state — construct one instance at REPL
 * startup and pass it alongside the `SessionManager` to
 * `startSessionTurn`/`finishSessionTurn`/`abortSessionTurn`.
 */
export class SessionAbortRegistry {
  private readonly controllers = new Map<string, AbortController>();

  /** True if a turn is currently registered (not necessarily un-aborted) for this session id. */
  has(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  /** @internal exposed mainly for tests. */
  get(sessionId: string): AbortController | undefined {
    return this.controllers.get(sessionId);
  }

  /** @internal used by startSessionTurn/finishSessionTurn/abortSessionTurn. */
  set(sessionId: string, controller: AbortController): void {
    this.controllers.set(sessionId, controller);
  }

  /** @internal used by finishSessionTurn. */
  delete(sessionId: string): void {
    this.controllers.delete(sessionId);
  }
}

/**
 * Begins a turn for `session`: registers a fresh `AbortController` for its
 * id (aborting and discarding any stale controller left over from a
 * previous turn on the same session — e.g. one that never reached
 * `finishSessionTurn` after an abort), sets `session.status = "running"`,
 * and returns the new controller's `AbortSignal` for `runAgentLoop`'s
 * `signal` option.
 */
export function startSessionTurn(
  sessionManager: SessionManager,
  registry: SessionAbortRegistry,
  session: HarnesSession
): AbortSignal {
  const stale = registry.get(session.id);
  if (stale && !stale.signal.aborted) stale.abort();

  const controller = new AbortController();
  registry.set(session.id, controller);
  sessionManager.setStatus(session.id, "running");
  return controller.signal;
}

/** Outcome of a finished turn, as reported to `finishSessionTurn`. */
export type SessionTurnOutcome = { ok: true } | { ok: false; error: string };

/**
 * Ends a turn for `session`: sets `status` back to `"idle"` (on success) or
 * `"error"` + `lastError` (on failure), and removes the session's entry
 * from `registry` so a later `startSessionTurn`/`abortSessionTurn` on the
 * same id doesn't see a stale, already-settled controller.
 *
 * An aborted turn should be reported with `{ ok: false, error: "aborted" }`
 * (or a more specific message) by the caller — this module does not infer
 * "aborted" from the signal itself, since `LoopResult.stoppedReason` already
 * tells the caller (A3) whether the turn completed, hit max-steps, was
 * denied, or was aborted.
 */
export function finishSessionTurn(
  sessionManager: SessionManager,
  registry: SessionAbortRegistry,
  session: HarnesSession,
  outcome: SessionTurnOutcome
): void {
  if (outcome.ok) {
    sessionManager.setStatus(session.id, "idle");
  } else {
    sessionManager.setStatus(session.id, "error", outcome.error);
  }
  registry.delete(session.id);
}

/**
 * Aborts the in-flight turn for `sessionId`, if one is registered and not
 * already aborted. Returns whether anything was actually aborted, so a
 * caller (e.g. a future `/session stop` command) can tell "stopped a
 * running turn" apart from "nothing was running."
 *
 * Deliberately does not touch `SessionManager` focus in any way — switching
 * which session is focused must never call this, and this never touches
 * focus. Only an explicit call (this function) stops a turn.
 */
export function abortSessionTurn(registry: SessionAbortRegistry, sessionId: string): boolean {
  const controller = registry.get(sessionId);
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  return true;
}
