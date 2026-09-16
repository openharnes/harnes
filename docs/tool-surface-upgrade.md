# Harnes tool surface upgrade — multi-agent brief

> **For Claude Code (or similar):** spawn up to **10 subagents** from the roster below.  
> **Do not** commit, push, publish to npm, or deploy. Leave a working tree + short handoff notes.  
> A human (or Cursor) will review everything and ship later.

## Product context

**Harnes** (`@openharnes/harnes`) is an open coding agent CLI: OpenRouter / Ollama / openai-compatible, persistent REPL, plan/build permissions, local exec backend.

### Tool surface today (keep these; extend them)

| Tool | Purpose |
|---|---|
| `read_file` | read whole file |
| `write_file` | overwrite whole file |
| `bash` | run any shell command |
| `glob` | file search by pattern |
| `grep` | regex content search |
| `list_dir` | directory listing |

Constraints today: plan/build gated, single local backend, no patch/diff tool, no test/lint integration, no network tools, tools run **sequentially**, uncapped `read_file`/`bash`.

### Explicitly out of scope for this pass

Do **not** implement:

- Web search / web fetch
- Docker / VM sandbox backends
- Notebook editors
- Vision / screenshot tools
- Shipping (git commit/push, npm publish, Vercel)

LSP may be **designed** only (Agent 10 notes); do not land a full LSP client unless it is a thin, optional stub behind a flag.

---

## Goals

Make Harnes’s coding loop competitive with Claude Code / Cursor CLI / opencode on the **core edit → verify** path:

1. Precise patches instead of whole-file overwrite as the default edit path  
2. Safe context (ranged reads + output caps)  
3. Parallel tool calls per model turn  
4. Explicit multi-step tracking (todos)  
5. Structured git + test/build tools  
6. Extensibility groundwork (subagents protocol, MCP MVP, skills/hooks)  

Preserve: charcoal REPL UX, `/mode` + ⌃T cycling, `/usage`, OpenRouter cost, local-only default.

---

## Architecture touchpoints (read before coding)

| Area | Likely files |
|---|---|
| Tool defs + loop | `src/loop.ts` |
| Permissions | `src/exec/types.ts` (`toolsForMode`, `isToolAllowed`, `needsApproval`) |
| Local backend | `src/exec/local.ts` |
| REPL wiring | `src/repl.ts` |
| Config | `src/config.ts` |
| Tests | `src/loop.test.ts`, `src/exec/*`, new `*.test.ts` |
| Docs | `docs/models.md`, `docs/product.md` (update tool tables when done) |

**Conventions**

- TypeScript, Node 20+, no new heavy deps unless an agent justifies one line in its handoff.  
- Every new tool: schema in `TOOLS`, executor path, plan/build gating, tests.  
- Prefer small diffs; keep `write_file` for create/overwrite, add `apply_patch` (or equivalent) for edits.  
- Cap tool outputs before they re-enter the model context.  
- Do not log API keys or dump `~/.config/harnes/config.json` secrets into transcripts.

---

## Wave plan (priority order)

Agents may run in parallel **within** a wave. Later waves should assume Wave 1 APIs exist (coordinate via shared types if parallelizing across waves).

### Wave 1 — coding loop (Agents 1–4)

Must land first for quality.

### Wave 2 — reliability (Agents 5–7)

Depends on Wave 1 caps + loop shapes.

### Wave 3 — leverage (Agents 8–10)

Can stub interfaces if Wave 1/2 still merging; prefer real MVPs over vapor.

---

## Subagent roster (10)

Each agent owns one slice. Deliver: code + tests + a short `HANDOFF.md` section (or comment block at top of PR-style summary in the agent’s final message) with: what changed, how to test, open risks.

---

### Agent 1 — Precise edit / patch tool

**Goal:** Add a first-class edit tool so the model stops rewriting whole files for small changes.

**Build**

- New tool, name bikeshed OK but prefer one of: `apply_patch`, `str_replace`, `edit_file`.  
- Support exact find/replace (unique old_string → new_string) and/or unified diff apply.  
- Fail clearly on 0 matches / ambiguous matches.  
- Keep `write_file` for create + intentional full overwrite.  
- Gate: denied in `plan`; allowed in `build` / approval modes like `write_file`.  
- Ask-on-edit / manual modes: treat like `write_file` for `needsApproval`.

**Acceptance**

- [ ] Unit tests: happy path, missing string, multiple matches, create-via-write still works  
- [ ] System prompt mentions preferring patch over full rewrite for edits  
- [ ] Plan mode cannot patch  

**Do not:** invent a separate VCS commit tool here (Agent 6).

---

### Agent 2 — Ranged reads + output caps

**Goal:** Stop blowing the context window.

**Build**

- Extend `read_file` with optional `offset` / `limit` (line-based is fine; document 1-based or 0-based clearly).  
- Truncate oversized results with a clear marker (`… truncated N bytes/lines …`).  
- Cap `bash` stdout/stderr (head + tail or max bytes).  
- Cap `list_dir` / large `glob` lists consistently with `grep`.  
- Shared helper e.g. `truncateOutput(text, opts)` used by all tools.

**Acceptance**

- [ ] Tests for ranged read and truncation markers  
- [ ] Default caps documented in tool descriptions  
- [ ] Existing explore tools still work in plan mode  

**Do not:** change permission model beyond what’s needed for new params.

---

### Agent 3 — Parallel tool execution

**Goal:** When the model returns multiple `tool_calls`, run independent ones concurrently.

**Build**

- Update `runAgentLoop` to execute a step’s tool calls in parallel when safe.  
- Preserve deterministic message order in the transcript (match model call order).  
- If one tool is denied/rejected by approval, define behavior: fail that call, don’t cancel siblings mid-flight unless necessary — document the choice.  
- `onProgress` should still fire per tool.  
- Consider a simple concurrency limit (e.g. 4–8).

**Acceptance**

- [ ] Test with ≥2 parallel mocks proving overlap or at least Promise.all semantics  
- [ ] Serial fallback or documented rules if a future tool is marked non-parallel  
- [ ] No prompt drift / broken REPL spinner from races (coordinate with existing `onProgress`)  

**Do not:** implement subagents here (Agent 8).

---

### Agent 4 — Todo / plan tracking tool

**Goal:** Explicit multi-step task list the agent updates as it works.

**Build**

- Tool e.g. `todo_write` / `todo_update` with items `{ id, content, status }`.  
- Persist in-memory for the session (REPL history lifetime); optional file under `.harnes/todos.json` is nice-to-have, not required.  
- Allowed in plan **and** build (read-only planning is a feature).  
- Light prompt guidance: update todos as work progresses; don’t spam.

**Acceptance**

- [ ] Tests for create/update/complete  
- [ ] Visible in `/status` or a small `/todos` slash command (optional but preferred)  
- [ ] Does not require network  

---

### Agent 5 — Git-native tools

**Goal:** Structured git instead of hoping the model bash-crafts it correctly.

**Build**

- Tools such as: `git_status`, `git_diff` (optional path), `git_log` (capped), and carefully gated `git_commit`.  
- Commit tool: require explicit message; never `--no-verify` unless future flag; never force push; never amend unless explicitly requested later.  
- Respect plan mode: status/diff/log OK; commit denied in plan.  
- Reuse output caps from Agent 2.

**Acceptance**

- [ ] Tests with a temp git repo (init in test)  
- [ ] Commit creates a real commit; failure paths are clear  
- [ ] Docs: prefer these over raw `git …` via bash when available  

**Do not:** implement hosting/PR create (`gh pr create`) in this pass.

---

### Agent 6 — Test / build runner tool

**Goal:** Structured verify step with pass/fail the model can trust.

**Build**

- Tool e.g. `run_tests` or `run_command_check` that runs a project’s test/build with:  
  - optional `command` override  
  - defaults discovery: `package.json` scripts (`test`, `lint`, `typecheck`, `build`) when present  
  - returns `{ exitCode, passed, summary, truncatedOutput }`  
- Still local backend; wrap rather than replace `bash`.  
- Ask-on-edit: treat as edit-like if it can mutate (usually run-only → auto in `ask` mode; document).

**Acceptance**

- [ ] Test against this repo’s `npm test` in a subprocess or mocked backend  
- [ ] Caps applied  
- [ ] Clear summary line for the model  

---

### Agent 7 — Prompt + permissions + UX polish for new tools

**Goal:** Make the new surface coherent end-to-end (this agent integrates Waves 1–2).

**Build**

- Update `systemPrompt` in `loop.ts` for patch-first edits, todos, git/test tools.  
- Ensure `toolsForMode` / `needsApproval` cover every new tool.  
- REPL: `/help` mentions new capabilities; footer unchanged unless a one-line hint helps.  
- Update `docs/models.md` (and product blurb) tool tables.  
- Smoke: `npm test` green; fix cross-cutting breakage from parallel merges.

**Acceptance**

- [ ] Full test suite green  
- [ ] Docs list new tools and modes  
- [ ] No secrets in docs or logs  

**Do not:** ship/publish.

---

### Agent 8 — Subagent protocol (MVP)

**Goal:** Spawn an isolated explore/build child with its own message list; return a summary to the parent.

**Build**

- Tool e.g. `delegate` / `subagent` with `{ task, mode?: plan|build, model?: inherit }`.  
- Child runs `runAgentLoop` with capped `maxSteps`, explore-biased tools by default.  
- Return final assistant summary + optional file touch list — **not** full raw transcript by default.  
- Depth limit 1 (no recursive spawn) for MVP.  
- Progress: parent status line shows `subagent: …`.

**Acceptance**

- [ ] Unit test with mocked complete() proving isolation  
- [ ] Hard max steps / timeout  
- [ ] Plan-mode parent cannot spawn build child that writes (or child inherits stricter mode — pick one and test it)  

**Do not:** multi-agent swarm UI; keep MVP.

---

### Agent 9 — MCP client MVP

**Goal:** Connect to external MCP servers so Harnes can gain tools without baking them all in.

**Build**

- Config shape under `~/.config/harnes/config.json` e.g. `mcpServers: { name: { command, args, env? } }`.  
- Stdio transport MVP; list tools; expose as namespaced tools `mcp__<server>__<tool>` or similar.  
- Lazy connect on first use; failures are tool errors, not crash.  
- `/mcp` slash command: list servers/tools/status.  
- Permissions: default deny in plan for mutating MCP tools if schema hints write; if unknown, ask in `ask` mode.

**Acceptance**

- [ ] Test with a mock MCP process or recorded handshake  
- [ ] Disabled by default when config empty  
- [ ] Docs snippet for adding one server  

**Do not:** implement marketplace UI; do not bundle third-party servers.

---

### Agent 10 — Skills / plugins + hooks (and LSP note)

**Goal:** On-demand skill files + thin hook points; document LSP as follow-up.

**Build**

- Load markdown skills from `~/.config/harnes/skills/` and/or `.harnes/skills/` in the workspace.  
- Tool or auto-inject: `skill` / `load_skill` returns skill body into context (capped).  
- Hooks MVP: `preToolUse` / `postToolUse` scripts or JS hooks in config (even no-op registry is OK if wired).  
- Short `docs/skills.md` explaining layout.  
- **LSP:** write `docs/lsp-plan.md` with proposed tools (`definition`, `references`, `diagnostics`) and deferred implementation — code stub optional.

**Acceptance**

- [ ] Skill load test with fixture file  
- [ ] Hook fires in a unit test (can be counter++)  
- [ ] LSP plan doc checked in  

---

## Cross-cutting requirements (all agents)

1. **Tests required** for behavioral changes (`npm test` must stay green when integrated).  
2. **No push / no publish / no `vercel --prod`.**  
3. **No API keys** in fixtures, docs, or examples.  
4. Prefer extending `LocalBackend` over forking a second exec model.  
5. If two agents touch `loop.ts`, rebase carefully; Agent 7 is the designated integrator.  
6. Match existing style: explicit types, minimal deps, MIT-friendly code.

---

## Suggested spawn commands (for the human operator)

Example orchestration:

1. Start Wave 1 agents **1, 2, 3, 4** in parallel.  
2. When Wave 1 merges locally, start **5, 6** in parallel; **7** after they land.  
3. Start **8, 9, 10** in parallel once Wave 2 compile is green (or after stubs from 7).

Each agent prompt should include:

- This file path: `docs/tool-surface-upgrade.md`  
- Their agent number + section only  
- “Do not commit/push/publish”  
- “Leave handoff notes in your final message”

---

## Definition of done (whole program)

Ready for human ship review when:

- [ ] Patch tool is default edit path in prompts  
- [ ] Ranged reads + caps on read/bash/glob/list  
- [ ] Parallel tool calls in the loop  
- [ ] Todos + git helpers + test runner exist  
- [ ] Subagent MVP + MCP MVP + skills MVP exist (even if MCP/skills are feature-flagged)  
- [ ] `npm test` + `npm run typecheck` green  
- [ ] Docs updated  
- [ ] No accidental commits/tags/publishes from agents  

Then: hand back to Cursor/human for review, version bump, commit, publish, deploy.

---

## Reference: competitive gaps (why this list)

| Category | Modern harnesses | Harnes today |
|---|---|---|
| Precise editing | patch / str-replace | whole-file write only |
| Ranged reads | offset/limit | full file |
| Parallel tools | common | sequential |
| Todos | common | none |
| Subagents | common | none |
| MCP | common | none |
| LSP | often | none |
| Git-native | often | bash only |
| Test runners | often | bash only |
| Skills/hooks | often | none |
| Web / sandbox | often | intentionally deferred |

---

*Last updated for Harnes post-0.2.3 REPL chrome. Adjust version numbers at ship time.*
