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

- Persistent REPL (`harnes`) with `/model`, `/mode`, `/usage`, live OpenRouter catalog + spend
- Agent loop with tools: read / write / bash / glob / grep / list_dir
- Permissions: plan = read-only explore; build = write + bash
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
