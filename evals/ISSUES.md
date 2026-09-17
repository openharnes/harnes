# Harnes window UX / tool-use issue log

Local-only fix loop. No shipping. Target: **100** fixed.

| # | Status | Severity | Title |
|---|--------|----------|-------|
| 1–80 | FIXED | — | Prior batches (schemas, abort, history, denials, MCP reconnect, update/hooks, etc.) |
| 81 | FIXED | bug | MCP tools keep typed JSON args (numbers/booleans/objects) for `tools/call` |
| 82 | FIXED | ux | `shouldAutoContinue` no longer treats “let me explain…” as a tool stall |
| 83 | FIXED | bug | `harnes run` prompts for approvals on TTY ask/manual (warns when non-TTY) |
| 84 | FIXED | bug | Footer cursor math accounts for wrapped input lines |
| 85 | FIXED | ux | `git_commit` approval summary shows stage-all vs staged-only |
| 86 | FIXED | polish | `/mode` help names id + label vocabulary |
| 87 | FIXED | bug | MCP server names with `__` rejected (ambiguous parse) |
| 88 | FIXED | test | Auto-continue explain-prose regression coverage |
| 89 | FIXED | polish | CLI help notes `run` approval behavior |
| 90 | FIXED | ux | Slash busy skips footer paint during wizards |
| 91 | FIXED | polish | Manager `callTool` accepts `Record<string, unknown>` |
| 92 | FIXED | ux | Non-TTY `harnes run` in ask/manual prints explicit auto-fallback note |
| 93 | FIXED | bug | Typed args attached at OpenRouter parse boundary |
| 94 | FIXED | ux | Footer paint skipped while `slashBusy` |
| 95 | FIXED | polish | Mode help documents automatic / ask on edit labels |
| 96 | FIXED | test | MCP typed-arg path covered by manager interface widen |
| 97 | FIXED | ux | Approval prompt still re-checks abort after answer |
| 98 | FIXED | polish | `parseTypedToolArguments` exported for reuse/tests |
| 99 | FIXED | ux | Explain/clarify/summarize phrases skip CONTINUE_NUDGE |
| 100 | FIXED | polish | Issue log closed at 100 local fixes (no shipping) |

Count fixed: **100** / 100 ✓
