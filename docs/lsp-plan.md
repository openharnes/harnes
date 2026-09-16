# LSP integration — deferred plan

Not implemented in this pass. This is a design note so a future pass can
land it without re-deriving the shape.

## Why defer

A real LSP client needs a per-language server process (typescript-language-server,
gopls, pyright, rust-analyzer, …), a `textDocument/didOpen` sync protocol
kept live across edits, and JSON-RPC framing over stdio. That's a
meaningfully heavier dependency than the rest of the tool surface (which is
all synchronous, process-per-call). It's also easy to get wrong in a way
that hangs the REPL (a language server that never responds), so it deserves
its own pass with its own timeout/lifecycle story rather than being bolted
onto this one.

## Proposed tools

Three read-only tools, mirroring the shape of `git_status` / `git_diff` —
capped output, denied nowhere (plan or build), never mutate:

### `lsp_definition`

- Args: `path` (file), `line`, `column` (1-based).
- Behavior: `textDocument/definition` against the language server for that
  file's language; returns the target file + line range, or "no definition
  found."
- Use case: "where is this function actually defined" without a full-text
  grep guess.

### `lsp_references`

- Args: `path`, `line`, `column`.
- Behavior: `textDocument/references`; returns a capped list of
  `path:line: context` entries (reuse `truncateOutput`/`truncateList` from
  `src/exec/output.ts`).
- Use case: "what calls this" / safe-to-rename checks before `edit_file`.

### `lsp_diagnostics`

- Args: `path` (optional; whole-project diagnostics if omitted, where the
  server supports it).
- Behavior: `textDocument/publishDiagnostics` (or pull diagnostics where
  supported); returns capped `path:line: [severity] message` entries.
- Use case: a faster, structured alternative to `run_tests script="typecheck"`
  for "did that edit break anything nearby" without a full compile.

## Architecture sketch

- New `src/exec/lsp.ts`: a thin client per language server, spawned lazily
  on first use and kept alive for the session (like the MCP client in
  Agent 9's work) rather than one-shot per call — LSP servers pay a real
  startup cost.
- Server discovery: a small table of `{ extension -> command }` (e.g.
  `.ts`/`.tsx` -> `typescript-language-server --stdio`), with a config
  override under `HarnesConfig.lsp.servers` for anything not built in.
  Missing binary -> tool returns a clear error, not a crash.
- JSON-RPC framing: `Content-Length` header + body over the process's
  stdio, matching the LSP spec. No existing dependency in this repo does
  this, so it either needs a small hand-rolled framer (a few dozen lines,
  no deps) or a single well-justified dependency (`vscode-jsonrpc` is the
  reference implementation) — the latter would be the "new heavy dep"
  exception called out in the tool-surface-upgrade doc, and should be
  justified in that pass's handoff rather than assumed here.
- Lifecycle: one server process per language per session, `didOpen` sent
  for a file the first time any `lsp_*` tool touches it, torn down when the
  backend closes (`ExecutionBackend.close()`).
- Permissions: read-only, so allowed in `plan` and `build` like the git
  read tools; never in `EDIT_TOOLS`.

## Acceptance criteria for a future implementation pass

- [ ] `lsp_definition` / `lsp_references` / `lsp_diagnostics` tools wired
      into `TOOLS`, `executeTool`, and `toolsForMode` (both modes)
- [ ] At least one language server (TypeScript, since this repo is
      TypeScript) working end to end in a test
- [ ] Missing server binary is a clear tool error, not a crash
- [ ] Output capped consistently with the rest of the tool surface
- [ ] Server process lifecycle documented and cleaned up on backend close
