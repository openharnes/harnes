# Slice A handoff

Status: **complete, verified, uncommitted.** Roster A1–A5 all landed; this is the main-gate
integration pass over their combined work. Nothing committed, pushed, or published — everything
below is sitting in the working tree for a human (or Cursor, for Slice B) to review.

## API

- Module path: `src/session-manager/` — `types.ts`, `manager.ts` (`InMemorySessionManager`,
  `createSessionManager(options?)`), `persist.ts`, `session-model.ts`, `session-turn.ts`.
- Focused session accessor: `sessionManager.focused(): HarnesSession` (throws only if the manager
  has zero non-archived sessions — `src/repl.ts` never lets that happen in practice, since it seeds
  a `"Session 1"` on first run and `archive()` always reassigns focus while any session remains).
- `SessionManager` interface matches `docs/multi-session-A.md`'s "Shared contract with Slice B"
  section field-for-field (`list/get/create/focus/focused/update/archive/save/load`), plus one
  **additive** method beyond the doc's sketch: `setStatus(id, status, lastError?)` — needed because
  `update()`'s patch type is deliberately narrow (`title | cwd | pinnedModelId | sessionMode`, to
  match the doc's contract literally) and `status`/`lastError` needed their own mutator. This is the
  one deviation from the doc's literal interface sketch; it's additive, so it doesn't break anything
  B builds against the documented shape.
- How B should subscribe to status changes: **poll on paint**, per the doc's own suggestion — there
  is no event emitter. `sessionManager.list()`/`.get(id)` return live `status`/`usage`/`history`
  fields B can read each render tick. If B needs push-based updates later, that's new scope, not
  landed here.
- `SessionAbortRegistry` (in `session-turn.ts`) is **not** part of `SessionManager` — it's a sibling
  object A3 constructs once in `startRepl` alongside the manager. B will need its own instance (or a
  shared one) if/when it drives concurrent per-pane turns; not decided here, flagged for whoever
  builds B's turn-driving.

## Slash commands shipped

| Command | Behavior |
|---|---|
| `/sessions` | Lists `id(8-char prefix) title pinnedModel(or "auto") cwd status`, `*` on focused |
| `/session` or `/session new [title]` | Create + focus (cwd inherited from the currently-focused session) |
| `/session <target>` | Focus by: exact id → unique short-id prefix → unique case-insensitive title match. Ambiguous prefix/title = no match, not a guess |
| `/session title <text>` | Rename focused |
| `/session cwd <path>` | Change focused session's `cwd` field, after `fs.existsSync` validation — **display/skills-only, see known gap below** |
| `/session archive` | Archive focused; manager auto-reassigns focus (REPL seeds a fresh session if that emptied the list) |

`/model`, `/mode`, `/todos`, `/clear` now act on the **focused session** instead of a global REPL
variable. `⌃T`/`⇧Tab` mode-cycling and the sidebar/footer chrome (added earlier today, same day as
this slice) also read the focused session live, so switching sessions correctly repaints them.

## Persist location

`~/.config/harnes/sessions/` (XDG-style — **deviates from the doc's `~/.harnes/sessions/` on
purpose**, to match the rest of the app: `src/config.ts`'s `~/.config/harnes/config.json` and
`src/models/catalog.ts`'s `~/.cache/harnes/openrouter-models.json`). One JSON file per session id
(`<id>.json`, full `HarnesSession` verbatim — no secrets, verified: `HarnesSession`/`ChatMessage`
carry no API-key field, and nothing from `HarnesConfig` is ever serialized), plus `index.json` for
`{ focusedId, archivedIds }`. Archived sessions stay on disk (soft-remove) — no GC exists yet.

Timing: `load()` once at startup (before the welcome box; `loadWarnings` surfaced via a muted print
line, never a crash), `save()` once on graceful shutdown alongside `backend.close()`/`mcp.close()`.
No autosave mid-session — a hard crash loses that session's turns since the last clean exit. This
was called out as the "safe minimum" by A2/A3 and is an accepted gap, not an oversight.

## Known gaps for B (and for a future Slice A follow-up)

- [ ] **`/session cwd` is display-only.** `LocalBackend` is constructed once at REPL startup with a
      fixed root; all file/bash tools stay sandboxed to the process's launch directory regardless of
      a session's `cwd` field. Only the footer/sidebar/`/status` display and `runAgentLoop`'s `cwd`
      option (used for skill discovery) follow the session's `cwd`. A real per-session sandboxed
      backend was out of scope for this slice — flagged, not silently swept under the rug (the REPL
      prints a note every time `/session cwd` is used).
- [ ] `/skills` and MCP server config still read the process launch cwd, not the focused session's —
      only `/model`/`/mode`/`/todos`/`/clear` were required to be session-scoped per the doc.
- [ ] No concurrent `runAgentLoop` across sessions — Slice A is single-visible-pane by design. The
      REPL tracks one `runningSessionId` at a time. `SessionAbortRegistry` and `startSessionTurn`/
      `finishSessionTurn`/`abortSessionTurn` are already session-keyed and ready for B to drive
      multiple turns in parallel; the REPL itself just never calls them more than once concurrently.
- [ ] No event emitter for transcript chunks / status changes — poll-on-paint only (see above).
- [ ] `save()` is not debounced and rewrites every session file on every call (currently called once
      on exit, so this is cheap today; would need debouncing before any hot-path autosave).
- [ ] No GC for archived session files.

## What's session-scoped vs. still-global (for B's reference)

Per-session: `history`, `todos`, `usage`, `pinnedModelId`, `sessionMode`, `cwd` (display-only, see
gap above), `title`, `status`, `lastError`.

Still on the single global `HarnesConfig`: `provider`/`openaiCompatible` (endpoint + key), `router`
defaults, `autoUpdate`, `mcpServers`, `hooks`, `defaultTier`. `config.pinnedModelId`/
`config.sessionMode` still exist on disk but are now only read once, as the seed for the very first
auto-created session — `/model`/`/mode` no longer write to them.

## Test status

- `npx tsc --noEmit`: **clean**, verified independently by the main gate after A3 landed.
- `npm test`: **244/244 passing**, run **3 times independently** by the main gate (not just
  self-reported by an agent) with zero failures across all runs — no flakiness.
- Manual acceptance flow (the doc's 10-step checklist) verified independently by the main gate via a
  real spawned `harnes` TTY process (`expect`-driven, isolated `$HOME`/cwd, deleted after):
  created 2 extra sessions (`alpha`, `beta`), pinned different models to each (`qwen3-coder-30b` /
  `claude-sonnet`), confirmed `/sessions` lists all 3 with correct `*`/model/status, confirmed the
  footer/model display follows focus, quit, reopened, confirmed all 3 sessions reloaded from disk
  with the correct session still focused and its pinned model intact. Real API calls (an actual
  chat turn) were **not** exercised since that needs a live OpenRouter key — the doc's step 4/9 were
  verified structurally instead (session isolation of `history`/`todos`/`usage`/pin is proven by the
  unit tests in `session-model.test.ts`/`manager.test.ts`, which do exercise `todo_write`-shaped
  mutations end-to-end without a network call).
- No real `~/.config/harnes/` state was touched by any of this verification — all smoke testing used
  an isolated `$HOME` and `cwd`, deleted afterward.

## Main-gate checklist (from docs/multi-session-A.md)

- [x] `npm run typecheck` clean
- [x] `npm test` green (244/244, 3x for flakiness)
- [x] Can create 3 sessions, pin different models, switch with `/session`, histories stay isolated
- [x] Restart Harnes → persisted sessions reload
- [x] No OpenHost / machines / grid UI code (grepped — none present)
- [x] SessionManager API documented above for B
- [x] Working tree only — no commit/push/publish (`git log` confirms zero new commits)

## Files touched (full slice)

```
docs/multi-session-A-HANDOFF.md   (this file)
src/repl.ts                       (A3 — modified, session-backed state + slash commands)
src/session-manager/types.ts      (A1, extended by A5)
src/session-manager/manager.ts    (A1, extended by A2 + A5)
src/session-manager/manager.test.ts
src/session-manager/persist.ts    (A2)
src/session-manager/persist.test.ts
src/session-manager/session-model.ts   (A4)
src/session-manager/session-model.test.ts
src/session-manager/session-turn.ts    (A5)
src/session-manager/session-turn.test.ts
```

`src/session.ts`/`src/session.test.ts` were modified earlier the same day by a separate, unrelated
sidebar-chrome task (not part of Slice A) and were left as-is by every Slice A agent per instruction.
