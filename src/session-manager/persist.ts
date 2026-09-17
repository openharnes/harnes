/**
 * Slice A — session persistence (Agent A2).
 *
 * Plain file I/O against `~/.config/harnes/sessions/` (see the "Persist
 * path" note below for why this deviates from docs/multi-session-A.md's
 * `~/.harnes/sessions/`). This module only reads/writes JSON — it never
 * touches `InMemorySessionManager` internals. `manager.ts`'s `save()` /
 * `load()` methods call the functions here, passing/receiving plain
 * serializable data so this module stays unit-testable against JSON alone.
 *
 * ## Layout
 *
 * ```
 * <sessionsDir>/
 *   index.json       # { focusedId?, archivedIds: string[] }
 *   <session-id>.json  # one HarnesSession per file
 * ```
 *
 * One file per session (rather than a single monolithic sessions.json) so a
 * corrupt/partial write to one session can never take down the rest — a
 * crash mid-write to `<id>.json` leaves every other session file untouched.
 * `index.json` carries the bits that aren't naturally part of a
 * `HarnesSession`: which id is focused, and which ids are archived (archived
 * sessions are still persisted as files so they survive restart for
 * possible un-archive / GC later, per the "soft-remove" contract in the
 * shared-contract doc).
 *
 * ## Persist path (deviation from docs/multi-session-A.md)
 *
 * The doc says `~/.harnes/sessions/`. The rest of the codebase is
 * consistently XDG-style instead — `src/config.ts` uses
 * `~/.config/harnes/config.json`, `src/models/catalog.ts`'s
 * `OPENROUTER_CACHE_PATH` uses `~/.cache/harnes/...`. This module follows
 * that convention and uses `~/.config/harnes/sessions/`. Flagging this
 * explicitly so the main integration pass and Slice B both use the real
 * path, not the doc's.
 *
 * ## No secrets on disk
 *
 * `HarnesSession` (src/session-manager/types.ts) has no apiKey/token field,
 * and this module never serializes a `HarnesConfig` (which is where API
 * keys / `openaiCompatible.apiKey` live) — only the plain-data
 * `HarnesSession` fields (`ChatMessage[]` history has no credential fields
 * either; see src/loop.ts). Do not widen what gets written here to include
 * a config object.
 *
 * ## Corrupt-file resilience
 *
 * `loadSessionsFromDisk` never throws on a malformed/partial JSON file. A
 * bad `<id>.json` (or a bad `index.json`) is skipped and recorded in the
 * returned `warnings: string[]`; every other valid session still loads.
 * Callers (manager.ts's `load()`) surface those warnings via a public
 * `loadWarnings` property rather than throwing, so one corrupt file can
 * never lose the rest of the sessions.
 */

import { randomUUID as _randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnesSession } from "./types.ts";

/** `~/.config/harnes/sessions` — override with `baseDir` in tests. */
export function defaultSessionsDir(): string {
  return path.join(os.homedir(), ".config", "harnes", "sessions");
}

function indexFilePath(dir: string): string {
  return path.join(dir, "index.json");
}

function sessionFilePath(dir: string, id: string): string {
  // Guard against path traversal via a crafted id; ids are randomUUID() in
  // practice, but don't trust it blindly when building a filesystem path.
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(dir, `${safeId}.json`);
}

/** Shape of index.json — the bits of manager state not on HarnesSession itself. */
export interface SessionIndex {
  focusedId?: string;
  archivedIds: string[];
}

/** Plain-data snapshot of manager state, as passed to saveSessionsToDisk(). */
export interface SessionSnapshot {
  sessions: HarnesSession[];
  archivedIds: string[];
  focusedId?: string;
}

/** Result of loadSessionsFromDisk(): valid sessions plus soft warnings for skipped files. */
export interface LoadResult {
  sessions: HarnesSession[];
  archivedIds: string[];
  focusedId?: string;
  /** Human-readable warnings for any file that was skipped (corrupt/unreadable). Never throws. */
  warnings: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Minimal structural check — enough to keep a garbled file from crashing load(), not full validation. */
function looksLikeHarnesSession(value: unknown): value is HarnesSession {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.cwd === "string" &&
    typeof value.sessionMode === "string" &&
    Array.isArray(value.history) &&
    Array.isArray(value.todos) &&
    isPlainRecord(value.usage) &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    typeof value.status === "string"
  );
}

/** Ensures the sessions directory exists (mkdir -p). */
export async function ensureSessionsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Writes every session (including archived ones) to `<id>.json` plus
 * `index.json`, under `dir`. Creates `dir` if needed. Each session file is
 * written independently, so a failure on one id does not prevent the
 * others from being written (best-effort; failures are collected and
 * thrown together at the end so callers still see something went wrong).
 */
export async function saveSessionsToDisk(dir: string, snapshot: SessionSnapshot): Promise<void> {
  await ensureSessionsDir(dir);

  const failures: string[] = [];
  await Promise.all(
    snapshot.sessions.map(async (session) => {
      try {
        await writeFile(sessionFilePath(dir, session.id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
      } catch (err) {
        failures.push(`${session.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  const index: SessionIndex = {
    focusedId: snapshot.focusedId,
    archivedIds: snapshot.archivedIds,
  };
  await writeFile(indexFilePath(dir), `${JSON.stringify(index, null, 2)}\n`, "utf8");

  if (failures.length > 0) {
    throw new Error(`saveSessionsToDisk: failed to write session(s): ${failures.join("; ")}`);
  }
}

/**
 * Reads back everything under `dir`. Never throws on a corrupt/missing
 * file — instead skips it and appends a message to `warnings`. A missing
 * `dir` (first run) yields an empty result, no warning.
 */
export async function loadSessionsFromDisk(dir: string): Promise<LoadResult> {
  const warnings: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { sessions: [], archivedIds: [], focusedId: undefined, warnings };
    }
    warnings.push(`could not list sessions dir "${dir}": ${err instanceof Error ? err.message : String(err)}`);
    return { sessions: [], archivedIds: [], focusedId: undefined, warnings };
  }

  let index: SessionIndex = { archivedIds: [] };
  if (entries.includes("index.json")) {
    try {
      const raw = JSON.parse(await readFile(indexFilePath(dir), "utf8")) as unknown;
      if (isPlainRecord(raw)) {
        index = {
          focusedId: typeof raw.focusedId === "string" ? raw.focusedId : undefined,
          archivedIds: Array.isArray(raw.archivedIds) ? raw.archivedIds.filter((x): x is string => typeof x === "string") : [],
        };
      } else {
        warnings.push(`index.json: not a JSON object, ignoring`);
      }
    } catch (err) {
      warnings.push(`index.json: corrupt (${err instanceof Error ? err.message : String(err)}), ignoring focus/archive state`);
    }
  }

  const sessionFiles = entries.filter((f) => f.endsWith(".json") && f !== "index.json");
  const sessions: HarnesSession[] = [];
  for (const file of sessionFiles) {
    const full = path.join(dir, file);
    try {
      const raw = JSON.parse(await readFile(full, "utf8")) as unknown;
      if (!looksLikeHarnesSession(raw)) {
        warnings.push(`${file}: does not look like a HarnesSession, skipping`);
        continue;
      }
      sessions.push(raw);
    } catch (err) {
      warnings.push(`${file}: corrupt JSON, skipping (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return { sessions, archivedIds: index.archivedIds, focusedId: index.focusedId, warnings };
}

/** Deletes a single session's file from disk. Best-effort — a missing file is not an error. */
export async function deleteSessionFile(dir: string, id: string): Promise<void> {
  try {
    await rm(sessionFilePath(dir, id));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") throw err;
  }
}
