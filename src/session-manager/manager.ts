/**
 * In-memory `SessionManager` implementation (Slice A, Agent A1), with
 * `save()`/`load()` filled in by Agent A2.
 *
 * `save()`/`load()` live here (as methods, with direct access to the
 * private `sessions`/`archived`/`focusedId` fields) rather than as a
 * free-floating module that would need to reach into those private fields
 * from outside the class. The actual file I/O — JSON read/write, path
 * resolution, corrupt-file handling — lives in ./persist.ts and is called
 * with plain serializable data, so persist.ts stays unit-testable against
 * JSON alone without spinning up a manager.
 */

import { randomUUID } from "node:crypto";
import { normalizeSessionMode } from "../exec/types.ts";
import { defaultSessionsDir, loadSessionsFromDisk, saveSessionsToDisk } from "./persist.ts";
import {
  freshUsage,
  type CreateSessionOptions,
  type HarnesSession,
  type SessionManager,
  type SessionUpdatePatch,
} from "./types.ts";

function defaultTitle(n: number): string {
  return `Session ${n}`;
}

/** Matches the default `Session N` titles created by defaultTitle(), for restoring nextOrdinal on load(). */
const DEFAULT_TITLE_RE = /^Session (\d+)$/;

/** Options accepted by `createSessionManager()` / `new InMemorySessionManager()`. */
export interface SessionManagerOptions {
  /**
   * Directory `save()`/`load()` read/write under. Defaults to
   * `~/.config/harnes/sessions` (see persist.ts's "Persist path" note for
   * why not the doc's `~/.harnes/sessions`). Tests should always pass a
   * temp dir here — never touch the real default.
   */
  persistDir?: string;
}

/**
 * In-memory, single-process session store.
 *
 * Invariants:
 * - At most one session is focused at any time; once at least one
 *   non-archived session exists, exactly one is focused.
 * - `create()` always focuses the newly created session.
 * - `archive()` on the focused session reassigns focus to the
 *   most-recently-updated remaining (non-archived) session, or clears
 *   focus entirely if none remain. Archiving a non-focused session never
 *   changes focus.
 * - `list()` never returns archived sessions, newest-active (updatedAt
 *   desc) first, per the shared contract with Slice B.
 */
export class InMemorySessionManager implements SessionManager {
  private readonly sessions = new Map<string, HarnesSession>();
  private readonly archived = new Set<string>();
  private focusedId: string | undefined;
  private nextOrdinal = 1;
  private readonly persistDir: string;

  /**
   * Soft warnings from the most recent `load()` — e.g. one corrupt session
   * file that was skipped. Empty after a clean load, or before the first
   * `load()` call. `load()` never throws for this; check here instead.
   */
  loadWarnings: string[] = [];

  constructor(options?: SessionManagerOptions) {
    this.persistDir = options?.persistDir ?? defaultSessionsDir();
  }

  list(): HarnesSession[] {
    return [...this.sessions.values()]
      .filter((s) => !this.archived.has(s.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): HarnesSession | undefined {
    if (this.archived.has(id)) return undefined;
    return this.sessions.get(id);
  }

  create(opts?: CreateSessionOptions): HarnesSession {
    const now = Date.now();
    const id = randomUUID();
    const session: HarnesSession = {
      id,
      title: opts?.title?.trim() || defaultTitle(this.nextOrdinal++),
      cwd: opts?.cwd ?? process.cwd(),
      pinnedModelId: opts?.pinnedModelId,
      sessionMode: normalizeSessionMode(opts?.sessionMode),
      history: [],
      todos: [],
      usage: freshUsage(),
      createdAt: now,
      updatedAt: now,
      status: "idle",
    };
    this.sessions.set(id, session);
    this.focusedId = id;
    return session;
  }

  focus(id: string): HarnesSession {
    const session = this.get(id);
    if (!session) {
      throw new Error(`SessionManager.focus: no such session "${id}"`);
    }
    this.focusedId = id;
    return session;
  }

  focused(): HarnesSession {
    if (!this.focusedId) {
      throw new Error("SessionManager.focused: no session is focused (none created, or all archived)");
    }
    const session = this.get(this.focusedId);
    if (!session) {
      // Should not happen (archive() always clears focusedId when it removes
      // the focused session), but guard anyway rather than returning stale data.
      throw new Error(`SessionManager.focused: focused session "${this.focusedId}" no longer exists`);
    }
    return session;
  }

  update(id: string, patch: SessionUpdatePatch): HarnesSession {
    const session = this.get(id);
    if (!session) {
      throw new Error(`SessionManager.update: no such session "${id}"`);
    }
    if (patch.title !== undefined) session.title = patch.title;
    if (patch.cwd !== undefined) session.cwd = patch.cwd;
    // Use `in` (not `!== undefined`) for pinnedModelId so callers can
    // explicitly clear a pin back to auto-route via `{ pinnedModelId: undefined }`
    // — a plain `!== undefined` check can never distinguish "clear the pin"
    // from "field omitted".
    if ("pinnedModelId" in patch) session.pinnedModelId = patch.pinnedModelId;
    if (patch.sessionMode !== undefined) session.sessionMode = normalizeSessionMode(patch.sessionMode);
    session.updatedAt = Date.now();
    return session;
  }

  /**
   * Sets `status` (and `lastError` for `"error"`) on a session. Added by
   * Agent A5 for loop integration (`session-turn.ts`) — deliberately a
   * separate method from `update()` rather than widening
   * `SessionUpdatePatch`, since that patch type mirrors the shared A/B
   * contract in docs/multi-session-A.md verbatim. `lastError` is cleared
   * whenever the new status isn't `"error"`.
   */
  setStatus(id: string, status: HarnesSession["status"], lastError?: string): HarnesSession {
    const session = this.get(id);
    if (!session) {
      throw new Error(`SessionManager.setStatus: no such session "${id}"`);
    }
    session.status = status;
    session.lastError = status === "error" ? lastError : undefined;
    session.updatedAt = Date.now();
    return session;
  }

  archive(id: string): void {
    const session = this.sessions.get(id);
    if (!session || this.archived.has(id)) return;
    this.archived.add(id);

    if (this.focusedId !== id) return;

    const remaining = this.list(); // already excludes the just-archived session
    this.focusedId = remaining[0]?.id;
  }

  /** Persists every session (including archived ones) plus focus/archive state under persistDir. */
  async save(): Promise<void> {
    await saveSessionsToDisk(this.persistDir, {
      sessions: [...this.sessions.values()],
      archivedIds: [...this.archived],
      focusedId: this.focusedId,
    });
  }

  /**
   * Replaces in-memory state with whatever is on disk under persistDir.
   * Never throws on a corrupt individual session file — that file is
   * skipped and a message is appended to `loadWarnings` instead, so one
   * bad file can't take down the rest of the sessions.
   */
  async load(): Promise<void> {
    const result = await loadSessionsFromDisk(this.persistDir);

    this.sessions.clear();
    this.archived.clear();
    for (const session of result.sessions) {
      this.sessions.set(session.id, session);
    }
    for (const id of result.archivedIds) {
      if (this.sessions.has(id)) this.archived.add(id);
    }

    this.focusedId =
      result.focusedId && this.get(result.focusedId) ? result.focusedId : this.list()[0]?.id;

    this.nextOrdinal = nextOrdinalAfter(result.sessions);
    this.loadWarnings = result.warnings;
  }
}

function nextOrdinalAfter(sessions: HarnesSession[]): number {
  let max = 0;
  for (const session of sessions) {
    const match = DEFAULT_TITLE_RE.exec(session.title);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export function createSessionManager(options?: SessionManagerOptions): SessionManager {
  return new InMemorySessionManager(options);
}
