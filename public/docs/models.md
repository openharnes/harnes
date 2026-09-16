# Models

Harnes supports **three inference paths**. Same agent runtime for all of them.

| Path | When | How |
|---|---|---|
| **OpenRouter** | Want every model, one key | `OPENROUTER_API_KEY` — live catalog in `/models` |
| **OpenHost** | Host your own weights in the cloud | Point `HARNES_MODEL_BASE_URL` at your [OpenHost](https://openhost.sh) OpenAI-compatible endpoint |
| **Local** | Fully on your machine | Ollama (default `http://127.0.0.1:11434/v1`) or any local OpenAI-compatible server |

## Install

```bash
npm install -g @openharnes/harnes
# or
curl -fsSL https://openharnes.com/install | bash
```

## Providers (config)

| Provider | When |
|---|---|
| `openrouter` | `OPENROUTER_API_KEY` is set (preferred cloud path) |
| `openai-compatible` | `HARNES_MODEL_BASE_URL` — OpenHost, vLLM, Fireworks, etc. |
| `ollama` | local `http://127.0.0.1:11434/v1` |

```bash
# 1) OpenRouter
export OPENROUTER_API_KEY=sk-or-...
harnes

# 2) OpenHost (or any hosted OpenAI-compatible URL)
export HARNES_MODEL_BASE_URL=https://your-openhost-endpoint/v1
export HARNES_MODEL_API_KEY=...
harnes

# 3) Local Ollama
export HARNES_PROVIDER=ollama
harnes
```

## Live catalog (OpenRouter)

`/models` and `harnes models` fetch OpenRouter’s live list (`GET /api/v1/models`), cache it ~1h at `~/.cache/harnes/openrouter-models.json`, and fall back to the curated list offline.

**Kept** (coding-capable + tool calling + context ≥ 8192): Qwen Coder, DeepSeek, Claude, GPT, Gemini, Llama 70B/72B/405B, Mixtral, Codestral.

**Dropped:** tiny/weak names, no tool-call support, or context &lt; 8192.

Pin any listed id: `/model qwen/qwen3-coder` or `/model auto`.

## Curated defaults (offline fallback)

| Tier | Id | OpenRouter slug | Context | Role |
|---|---|---|---|---|
| strong-open | `qwen3-coder-30b` | `qwen/qwen3-coder` | 65k | Default build / agent work |
| fast-open | `qwen3-coder-8b` | `qwen/qwen3-coder-flash` | 32k | Explore / compact |
| strong-open | `deepseek-v3` | `deepseek/deepseek-chat-v3-0324` | 65k | Open-weight daily driver |
| frontier-byok | `claude-sonnet` | `anthropic/claude-sonnet-4.5` | 200k | Hard architecture (BYOK) |
| frontier-byok | `gpt-5` | `openai/gpt-5` | 128k | Hard architecture (BYOK) |

## Tiers & routing

- **fast-open** — explore, titles, compaction
- **strong-open** — default agent loop (auto/build)
- **frontier-byok** — only when frontier is allowed / pinned

```bash
harnes route "explore this repo"
harnes route "add a retry policy"
harnes smoke
```

## Session commands

| Command | Effect |
|---|---|
| `/models` | list live + curated catalog |
| `/model` | show active model |
| `/model auto` | hybrid route per prompt |
| `/model <id>` | pin a catalog / OpenRouter slug |
| `/mode auto\|manual\|ask\|plan` | approval mode (⌃T / ⇧Tab; Warp: prefer ⌃T) |
| `/usage` (`/cost`) | session spend + OpenRouter today / week / month |
| `/update` | install latest from npm |
| `/update auto on\|off` | opt-in auto-install on startup |

## Tools (agent)

| Mode | Tools |
|---|---|
| plan | `read_file`, `glob`, `grep`, `list_dir`, `todo_write`, `git_status`, `git_diff`, `git_log`, `delegate` |
| build | + `write_file`, `edit_file`, `bash`, `git_commit`, `run_tests` |

- `read_file` supports `offset`/`limit` for ranged reads of large files; all tool output is capped with a `... truncated ...` marker instead of blowing out the context window.
- `edit_file` is the default path for changes to existing files (exact `old_string` → `new_string`, patch-style); `write_file` is for creating new files or intentional full-file rewrites.
- `todo_write` tracks multi-step work for the session; see it any time with `/todos`.
- `git_status` / `git_diff` / `git_log` are read-only and allowed in plan mode; `git_commit` requires an explicit message, never force-pushes, amends, or skips hooks, and is denied in plan mode.
- `run_tests` runs the project's test/lint/typecheck/build step (defaults to the `package.json` "test" script) and returns a pass/fail verdict instead of raw shell output; denied in plan mode.
- A single model turn can return multiple tool calls; independent ones run in parallel (capped concurrency) while the transcript keeps model call order.
- `delegate` spawns an isolated subagent (own message list, no parent history) for a bounded, self-contained task. Capped at 6 steps and a 90s timeout; returns a summary + files-touched list, not the full transcript. A subagent can't be more permissive than its parent (a plan-mode session only ever spawns plan-mode subagents) and can't spawn further subagents (depth limit 1).

## MCP servers (optional)

Harnes can connect to external [MCP](https://modelcontextprotocol.io) servers over stdio and expose their tools to the agent loop, namespaced `mcp__<server>__<tool>`. Disabled by default — nothing is spawned unless you configure at least one server.

Add servers under `mcpServers` in `~/.config/harnes/config.json`:

```json
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": { "SOME_TOKEN": "..." }
    }
  }
}
```

- Connections are lazy: a configured server isn't spawned until its tools are actually needed (the first agent turn of a session, an explicit call, or `/mcp`). A server that fails to start or respond produces a tool error, not a crash.
- Run `/mcp` to list configured servers, their connection status, and their tools.
- Permissions: each tool is classified `read`/`write`/`unknown` from the server's MCP `annotations` (or a name/description heuristic when a server doesn't provide them). `plan` mode only allows tools classified `read`; `ask` mode auto-runs a `read` tool but prompts before a `write` or `unknown` one, same as it does for `write_file`/`bash`.
- Do not put API keys or secrets directly in `config.json` if you plan to share it — use `env` with a value read from your own shell/secret manager instead.
