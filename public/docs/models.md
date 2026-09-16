# Models

Default cloud path is **OpenRouter** (`OPENROUTER_API_KEY`). Local fallback is Ollama.

## Providers

| Provider | When |
|---|---|
| `openrouter` | `OPENROUTER_API_KEY` is set (preferred) |
| `ollama` | default local `http://127.0.0.1:11434/v1` |
| `openai-compatible` | any `HARNES_MODEL_BASE_URL` |

```bash
export OPENROUTER_API_KEY=sk-or-...
harnes models
harnes run "explain this repo"
```

## Catalog

`harnes models` isn't five hardcoded rows. It fetches the live OpenRouter model list (`GET /models`),
caches it for about an hour in `~/.cache/harnes/openrouter-models.json`, and merges it with a small
curated fallback list used when there's no network and no cache yet. Listings are filtered down to
coding-capable models (Qwen Coder, DeepSeek, Claude, GPT, Gemini, Llama 70B+) with real tool-calling
support — tiny or unproven models are dropped rather than offered.

## Tiers

- **fast-open** — Qwen3 Coder flash / 8B. Explore / compact.
- **strong-open** — Qwen3 Coder / DeepSeek V3. Daily agent work.
- **frontier-byok** — Claude Sonnet / GPT-5 via OpenRouter. Hard architecture when enabled.

```bash
harnes models
harnes route "explore this repo"
harnes smoke
```

`harnes smoke` is the agentic gate: file-edit class models only, no weak defaults.
