/**
 * Slice B All-mode — constants + pane transcript overlay.
 * Session types come from Slice A's `src/session-manager` (shared contract).
 */
export type {
  HarnesSession,
  SessionManager,
  CreateSessionOptions,
  SessionStatus,
} from "../session-manager/types.ts";

/** All-mode shows at most this many panes. */
export const ALL_MODE_MAX_PANES = 4;

/** Below this terminal size, refuse All mode. */
export const ALL_MODE_MIN_TERM_WIDTH = 100;
export const ALL_MODE_MIN_TERM_ROWS = 24;

/**
 * Per-session progress/transcript lines for All-mode pane bodies.
 * Kept off `HarnesSession` so A's persist format stays unchanged.
 */
export class PaneTranscriptStore {
  private readonly lines = new Map<string, string[]>();

  append(sessionId: string, line: string, maxLines = 40): void {
    const text = line.replace(/\s+/g, " ").trim();
    if (!text) return;
    const list = this.lines.get(sessionId) ?? [];
    list.push(text);
    if (list.length > maxLines) list.splice(0, list.length - maxLines);
    this.lines.set(sessionId, list);
  }

  get(sessionId: string): string[] {
    return this.lines.get(sessionId) ?? [];
  }

  clear(sessionId: string): void {
    this.lines.delete(sessionId);
  }
}

/** Ensure the manager has at least `count` sessions (capped at ALL_MODE_MAX_PANES). */
export function ensureSessionCount(
  manager: import("../session-manager/types.ts").SessionManager,
  count: number,
  cwd: string
): import("../session-manager/types.ts").HarnesSession[] {
  const target = Math.min(ALL_MODE_MAX_PANES, Math.max(1, count));
  while (manager.list().length < target) {
    const n = manager.list().length + 1;
    manager.create({ cwd, title: `Pane ${n}` });
  }
  return manager.list().slice(0, target);
}
