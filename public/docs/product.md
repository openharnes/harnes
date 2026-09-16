# Product

**One-liner:** Harnes is the open coding agent.

| Name | Role |
|---|---|
| OpenHarnes | Full product name (one *s*) |
| Harnes | Spoken / short name |
| `harnes` | CLI — opens a persistent session |

## Install

```bash
npm install -g @openharnes/harnes
# or
curl -fsSL https://openharnes.com/install | bash
harnes
```

Requires Node 20+. First run walks through OpenRouter or Ollama setup.

## Buyer

Teams that want an autonomous coding agent with open models (OpenRouter / local) and no seat lock-in.

## What you get

- Persistent REPL (`harnes`) with `/model`, `/mode`, `/usage`, `/update`, `/todos`, live OpenRouter catalog + spend
- Shift+Tab cycles approval modes: automatic → manual → ask on edit → plan
- Agent loop with tools: `read_file` (ranged reads), `write_file`, `edit_file` (patch-style edits), `bash`, `glob`, `grep`, `list_dir`, `todo_write`, `git_status` / `git_diff` / `git_log` / `git_commit`, `run_tests`, `delegate` (isolated, capped subagent for bounded subtasks) — all with capped output, and independent tool calls in a turn run in parallel
- Permissions: plan = read-only explore + todos + git read tools; build = + write/edit/bash/commit/run_tests
- Hybrid routing: fast-open / strong-open / frontier-byok
- **Three model paths:** OpenRouter (all models), OpenHost (host your own), or local Ollama
- MIT licensed — no seat fee

## Quality claim

We sell a strong **runtime** (tools, permissions, routing, recovery) with open models by default. We do not sell “Opus quality on any open-source model.”

OpenHost is a separate product for hosting models; Harnes is the agent that talks to OpenRouter, OpenHost, or local endpoints.

## Links

- Site: https://openharnes.com
- npm: https://www.npmjs.com/package/@openharnes/harnes
- GitHub: https://github.com/openharnes/harnes
- Models: [models.md](./models.md)
