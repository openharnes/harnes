# Models

Default cloud path is **OpenRouter** (`OPENROUTER_API_KEY`). Local fallback is Ollama. Any OpenAI-compatible endpoint works via `HARNES_MODEL_BASE_URL`.

## Install

```bash
npm install -g @openharnes/harnes
# or
curl -fsSL https://openharnes.com/install | bash
```

## Providers

| Provider | When |
|---|---|
| `openrouter` | `OPENROUTER_API_KEY` is set (preferred) |
| `ollama` | local `http://127.0.0.1:11434/v1` |
| `openai-compatible` | any `HARNES_MODEL_BASE_URL` (+ optional `HARNES_MODEL_API_KEY`) |

```bash
export OPENROUTER_API_KEY=sk-or-...
harnes                 # persistent session
harnes models          # live + curated catalog
harnes run "explain this repo"
```

## Live catalog

`/models` and `harnes models` fetch OpenRouter’s live list (`GET /api/v1/models`), cache it ~1h at `~/.cache/harnes/openrouter-models.json`, and fall back to the curated list offline.

**Kept** (coding-capable + tool calling + context ≥ 8192):

- Qwen Coder family
- DeepSeek
- Claude
- GPT
- Gemini
- Llama 70B / 72B / 405B
- Mixtral
- Codestral

**Dropped:** tiny / weak names (2B–4B, tinyllama, phi-mini, …), no tool-call support, or context &lt; 8192.

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
harnes route "explore this repo"   # → fast-open
harnes route "add a retry policy"  # → strong-open
harnes smoke                       # reject weak models
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

`harnes smoke` is the agentic gate: file-edit class models only, no weak defaults.
