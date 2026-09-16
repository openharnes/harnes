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
| `/mode auto\|plan\|build` | tools + routing mode |

## Tools (agent)

| Mode | Tools |
|---|---|
| plan | `read_file`, `glob`, `grep`, `list_dir` |
| build | + `write_file`, `bash` |
