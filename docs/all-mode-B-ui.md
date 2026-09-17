# Harnes All-mode UI (Slice B) — Cursor track

> **Owner:** Cursor (this track), while Claude builds **Slice A** (`docs/multi-session-A.md`).  
> **Parked:** machines / OpenHost / remote fleet (`openhost.sh`). Local only.  
> **Do not** re-implement SessionManager here — consume A's API. If A isn't landed yet, build UI against the **contract** in `docs/multi-session-A.md` with a thin mock.

## Goal

**All mode:** show up to **4 Harnes panes** at once (2×2). Each pane = one local session (own model, cwd, transcript, todos). Switch focus for input; others can keep streaming when concurrent runs land.

Reference vibe: multi-pane agent dashboard (colored pane headers, model + task + host labels) — but **host is always local** for now.

## Out of scope

- Machines sidebar / remote hosts  
- Shipping unless asked  
- Replacing Slice A's session persistence  
- More than 4 live panes in v1  

## Depends on Slice A

From `SessionManager`:

- `list` / `get` / `create` / `focus` / `focused`  
- per-session `pinnedModelId`, `history`, `todos`, `usage`, `status`  
- ideally a way to observe updates (poll on paint is OK for MVP)

## UI deliverables (this track)

1. **Layout modes**
   - `single` — current one-pane REPL (default)
   - `all` — 2×2 grid, up to 4 session slots  
2. **Pane chrome**
   - Header: model name · session title · cwd (short)  
   - Body: transcript + live progress trail (reuse existing progress events)  
   - Footer strip: mode · spend · step status  
3. **Focus model**
   - One focused pane receives keystrokes  
   - Keybind sketch: `Ctrl+A` then `1–4` or `Tab` cycle (document final)  
4. **Slash**
   - `/all` enter All mode (create/fill up to 4 sessions if needed)  
   - `/single` back to one pane  
5. **Empty slots**
   - “New session” placeholder; creating assigns SessionManager.create()

## Technical approach (recommended)

TTY `readline` cannot own 4 cursors cleanly. Prefer one of:

| Option | Pros | Cons |
|---|---|---|
| **B1. Full TUI shell** (OpenTUI / similar) wrapping agent core | Matches mockup; real panes | Larger dependency / rewrite of paint path |
| **B2. Hybrid** — All mode renders 4 clipped transcript regions + one shared input line (“focused → session N”) | Ships faster on current stack | Less “true terminal in each pane” |

**Start with B2** unless TUI is already chosen; keep paint functions pure so B1 can replace the shell later.

## Parallel-run note

A may only switch focus (one running turn). B should:

- Call into a `runSessionTurn(sessionId, prompt)` helper (add if A didn't)  
- Cap at **4** concurrent `running` sessions  
- Surface cost warnings when 4× frontier models are pinned  

## Acceptance (manual)

```text
1. /all → 2×2 (empty slots OK)
2. Create/fill 4 local sessions; pin 4 different models
3. Focus pane 2; type a prompt → only pane 2 streams (or all stream if concurrent enabled)
4. /single → back to classic REPL on focused session
5. Terminal width < threshold → refuse All mode or fall back to single with a clear message
```

## Coordination with A

- Do not edit `src/session-manager/**` while Claude owns A — mock the interface locally if blocked.  
- When A hands off, swap mock → real manager and fix types.  
- Final tie-up (evaluate A + wire B) is a **later Cursor pass** after both tracks report done.
