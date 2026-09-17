/**
 * Slice A — multi-session types.
 *
 * `HarnesSession` / `SessionManager` are the shared contract with Slice B
 * (Cursor's All-mode grid UI) — see docs/multi-session-A.md, "Shared
 * contract with Slice B". Field names/shapes here should match that doc
 * as closely as possible; do not rename casually.
 *
 * Uses the real types from the rest of the codebase rather than redeclaring
 * copies: `ChatMessage` (src/loop.ts), `TodoItem` (src/todos.ts),
 * `SessionUsage` (src/session.ts), `SessionMode` (src/exec/types.ts).
 */

import type { ChatMessage } from "../loop.ts";
import type { TodoItem } from "../todos.ts";
import type { SessionUsage } from "../session.ts";
import type { SessionMode } from "../exec/types.ts";

export type { ChatMessage } from "../loop.ts";
export type { TodoItem } from "../todos.ts";
export type { SessionUsage } from "../session.ts";
export type { SessionMode } from "../exec/types.ts";

/** Lifecycle status of a session, surfaced to B so it can render busy panes. */
export type SessionStatus = "idle" | "running" | "error";

export interface HarnesSession {
  /** Stable id (uuid). */
  id: string;
  /** Derived or user-set title. */
  title: string;
  cwd: string;
  /** Unset = auto-route. */
  pinnedModelId?: string;
  sessionMode: SessionMode;
  history: ChatMessage[];
  todos: TodoItem[];
  usage: SessionUsage;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  lastError?: string;
}

/** Options accepted by `SessionManager.create`. */
export interface CreateSessionOptions {
  cwd?: string;
  title?: string;
  pinnedModelId?: string;
  sessionMode?: SessionMode;
}

/** Fields `SessionManager.update` is allowed to patch. */
export type SessionUpdatePatch = Partial<
  Pick<HarnesSession, "title" | "cwd" | "pinnedModelId" | "sessionMode">
>;

export interface SessionManager {
  /** newest-active first is fine. */
  list(): HarnesSession[];
  get(id: string): HarnesSession | undefined;
  create(opts?: CreateSessionOptions): HarnesSession;
  focus(id: string): HarnesSession;
  focused(): HarnesSession;
  update(id: string, patch: SessionUpdatePatch): HarnesSession;
  /**
   * Sets a session's lifecycle `status` (and, for `"error"`, an optional
   * `lastError`). Added by Agent A5, additively — kept separate from
   * `update()`/`SessionUpdatePatch` (whose patch type is the shared-contract
   * shape from docs/multi-session-A.md and intentionally does not include
   * `status`/`lastError`) rather than widening that patch type. `lastError`
   * is cleared (set to `undefined`) whenever status is set to something
   * other than `"error"`, so a stale error message never lingers once a
   * session recovers.
   */
  setStatus(id: string, status: HarnesSession["status"], lastError?: string): HarnesSession;
  /** Soft-remove from switcher; do not delete disk until GC if persisting. */
  archive(id: string): void;
  /** Persist all sessions (or dirty ones) under ~/.harnes/sessions/. Stubbed here — see persist.ts (A2). */
  save(): Promise<void>;
  /** Load sessions back from disk. Stubbed here — see persist.ts (A2). */
  load(): Promise<void>;
}

export function freshUsage(): SessionUsage {
  return {
    turns: 0,
    agentSteps: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
  };
}
