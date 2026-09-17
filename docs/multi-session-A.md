# Harnes multi-session (Slice A) — multi-agent brief

> **For Claude Code (or similar):** spawn the subagents below; keep a **main agent** that integrates, runs tests, and blocks merge until acceptance passes.  
> **Do not** commit, push, publish to npm, or deploy unless the human explicitly asks. Leave a clean working tree + handoff notes.  
> **Parked (out of scope):** machines / fleet / `openhost.sh` / remote hosts / SSH workers. Local machine only.  
> **Parallel track:** Cursor is building **Slice B UI** (All-mode 2×2 layout). Do **not** implement the grid UI here. Export the **session API** B needs (see contract below).

## Product context

**Harnes** (`@openharnes/harnes`) is an open coding agent CLI: OpenRouter / Ollama, persistent REPL, plan/build permissions, local tools.

**Today:** one process → one cwd → one history → one pinned model → one transcript.

**Slice A goal:** multiple **local sessions** in one Harnes process (or one supervisor), switch focus between them, each with its own model / cwd / history / todos / usage. Still **one visible pane** for input (B adds the 2×2 grid later).

**Slice B (not this doc):** All mode — up to 4 panes visible and running in parallel. Cursor owns UI. A must make sessions first-class so B can attach panes to session ids.

---

## Explicitly out of scope (Slice A)

Do **not** implement:

- Machines sidebar / remote hosts / OpenHost / e2b fleet
- 2×2 All-mode grid layout, pane chrome, multi-cursor TUI shell (that's B)
- Shipping (commit / push / npm publish / Vercel) unless asked
- LSP client, new tool surface, eval harness changes (unless a test needs a tiny hook)
- Syncing sessions across machines

---

## Goals

1. Create / list / focus / archive (or kill) **local sessions**.
2. Each session owns: `id`, `title`, `cwd`, `pinnedModelId` (or auto), `sessionMode`, `history`, `todos`, `usage`, `createdAt`, `updatedAt`.
3. REPL can **switch focus** without losing other sessions' state (in memory + optional disk persist).
4. A focused session can run a normal agent turn; unfocused sessions stay idle in A (B will run up to 4 concurrently later — design for that, don't build the grid).
5. Export a **stable SessionManager API** that B can import.

### Non-goals for A

- Rendering more than one transcript at once
- Fancy machines UX
- Guaranteeing 4 concurrent API calls (B + later; A should not forbid it)

---

## Shared contract with Slice B (do not break)

B will import something shaped like this (names can vary; keep behavior):

```ts
// Conceptual — put the real module under src/session-manager/ (or similar)

interface HarnesSession {
  id: string;                 // stable uuid/short id
  title: string;              // derived or user-set
  cwd: string;
  pinnedModelId?: string;     // unset = auto-route
  sessionMode: SessionMode;   // auto | manual | ask | plan
  history: ChatMessage[];
  todos: TodoItem[];
  usage: SessionUsage;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "running" | "error";
  lastError?: string;
}

interface SessionManager {
  list(): HarnesSession[];                    // newest-active first is fine
  get(id: string): HarnesSession | undefined;
  create(opts?: { cwd?: string; title?: string; pinnedModelId?: string }): HarnesSession;
  focus(id: string): HarnesSession;
  focused(): HarnesSession;
  update(id: string, patch: Partial<Pick<HarnesSession, "title" | "cwd" | "pinnedModelId" | "sessionMode">>): HarnesSession;
  /** Soft-remove from switcher; do not delete disk until GC if you persist. */
  archive(id: string): void;
  /** Persist all sessions (or dirty ones) under ~/.harnes/sessions/ */
  save(): Promise<void>;
  load(): Promise<void>;
}
```

**Hard rules for B compatibility:**

- Max **practical** sessions unbounded in A; B will only **display/run up to 4** at once.
- `status: "running"` must be set around `runAgentLoop` so B can show busy panes.
- Do not put UI/ANSI in `SessionManager` — keep it pure/stateful.
- Prefer one module + tests; REPL becomes a **consumer**, not the owner of history arrays.

---

## Suggested file layout

```
src/session-manager/
  types.ts
  manager.ts          # SessionManager impl
  persist.ts          # ~/.harnes/sessions/*.json (or single index.json)
  manager.test.ts
src/repl.ts           # wire: focused session drives turn; slash cmds for switch
docs/multi-session-A.md  # this file
```

Persist format should be JSON, forward-compatible, no API keys written to disk (keep using env / existing config for keys).

---

## REPL UX for A (single pane)

Add slash commands (names flexible, document finals in handoff):

| Command | Behavior |
|---|---|
| `/sessions` | list id, title, model, cwd, status (`*` = focused) |
| `/session` or `/session new` | create + focus (optional title/cwd args) |
| `/session <id>` | focus existing |
| `/session title <text>` | rename focused |
| `/session cwd <path>` | change focused cwd (validate exists) |
| `/session archive` | archive focused; focus another |

Keep existing `/model`, `/mode`, `/todos`, `/clear` scoped to **focused** session.

Welcome / footer / sidebar (if present) should reflect **focused** session only in A.

---

## Multi-agent roster (main agent coordinates)

Spawn these as **subagents**. Main agent owns the branch tip, runs `npm test` / `npm run typecheck`, and writes `docs/multi-session-A-HANDOFF.md` when done.

| Agent | Owns | Deliverable |
|---|---|---|
| **A1 — Types & manager core** | `src/session-manager/types.ts`, `manager.ts` | In-memory create/list/focus/update/archive; unit tests for invariants (one focused; create focuses; archive switches focus) |
| **A2 — Persist** | `src/session-manager/persist.ts` | Load/save under `~/.harnes/sessions/`; no secrets; corrupt-file resilience; tests with temp dirs |
| **A3 — REPL wire-up** | `src/repl.ts` (minimal diff) | Focused session backs history/todos/usage/model/cwd; slash commands above; `/clear` clears focused only |
| **A4 — Model/mode per session** | glue in manager + REPL | `/model` and `/mode` write to focused session; new session can start with different pin |
| **A5 — Running status + Abort** | loop integration | Set `status=running` during turn; `AbortController` per session; unfocus mid-turn does **not** kill the turn in A (document behavior); optional `/session stop` aborts focused |
| **Main — Integrate & gate** | all | Resolve conflicts; full `npm test` + `typecheck`; handoff doc; **do not ship** |

### Main-agent checklist (must pass)

- [ ] `npm run typecheck` clean  
- [ ] `npm test` green  
- [ ] Can create 3 sessions, pin different models, switch with `/session`, histories stay isolated  
- [ ] Restart Harnes → persisted sessions reload (if A2 landed)  
- [ ] No OpenHost / machines / grid UI code  
- [ ] SessionManager API documented in handoff for B  
- [ ] Working tree only (no commit/push/publish unless human asks)

---

## Acceptance tests (manual)

```text
1. harnes
2. /session new
3. /model <id-a>          # pin model A on session 1
4. ask a short question → answer lands in session 1 history
5. /session new
6. /model <id-b>          # different model
7. /sessions              # shows 2 sessions, * on focused
8. /session <id-of-1>     # switch back — prior answer still in history
9. /todos on each session stay independent after todo_write turns
10. quit + reopen → sessions still listed (persist)
```

---

## Parallelism rules for subagents

- **A1 → A2** can be sequential (A2 needs types) or A2 stubs against A1's types file first.  
- **A3/A4/A5** start after A1's API surface exists (even if persist is WIP).  
- No two agents edit `src/repl.ts` at the same time — main agent serializes REPL patches or assigns only A3 to `repl.ts` and has A4/A5 expose helpers A3 calls.  
- Prefer **small PRs of files**, not mega-diffs.  
- If blocked on B assumptions, write them in handoff — do not invent grid UI.

---

## Handoff template (main agent writes `docs/multi-session-A-HANDOFF.md`)

```markdown
# Slice A handoff

## API
- Module path:
- Focused session accessor:
- How B should subscribe to status changes (events? poll?):

## Slash commands shipped
- ...

## Persist location
- ...

## Known gaps for B
- [ ] concurrent runAgentLoop on N sessions
- [ ] event emitter for transcript chunks
- ...

## Test status
- typecheck:
- npm test:
```

---

## After A + B

Human will have Cursor **evaluate A** and **tie it to B** (All mode binds panes → session ids, max 4 running). Do not pre-merge grid code into A.
