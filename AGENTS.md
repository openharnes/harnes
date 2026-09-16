# Parallel work lanes

## Owned here (persistent session)
- `src/cli.ts` `src/repl.ts` `src/session.ts` `src/loop.ts` `src/config.ts` `src/positioning.ts` `public/install.sh`

## Copilot / Claude — stay out of those files unless a type export is required

---

## Prompt for Copilot: add real agent tools

```
You are working in the OpenHarnes repo. Do NOT edit src/repl.ts, src/cli.ts, src/session.ts, or public/install.sh.

Goal: give the agent a real coding tool surface so `harnes` can explore repos (the user asked “what’s in this repo?” and got a hallucinated listing).

Work only in:
- src/loop.ts (register tools + executeTool)
- src/exec/local.ts (implement filesystem helpers)
- src/exec/types.ts (extend ExecutionBackend if needed)
- src/loop.test.ts

Required tools (native, local cwd — no OpenHost):
1. glob(pattern) — workspace file search, skip node_modules/.git/.next
2. grep(pattern, path?, glob?) — ripgrep-style content search, cap output (~20k chars)
3. list_dir(path?) — directory listing
4. Keep existing read_file, write_file, bash
5. Plan mode: allow glob, grep, list_dir, read_file only. Deny write_file and bash.

Wire them through TOOLS + executeTool. Validate paths stay under the backend root. Truncate huge results. Add tests for glob, grep, plan-mode deny.

Do not mention OpenHost. Do not add network tools unless asked.
```

---

## Prompt for Claude: OpenRouter catalog

```
You are working in the OpenHarnes repo. Do NOT edit src/repl.ts, src/cli.ts, src/session.ts, or public/install.sh.

Goal: support OpenRouter models as a real catalog, not five hardcoded rows.

Work only in:
- src/models/catalog.ts
- src/models/router.ts
- src/models/*.test.ts
- docs/models.md (optional)

Requirements:
1. Fetch GET https://openrouter.ai/api/v1/models (optional Authorization: Bearer from OPENROUTER_API_KEY). Cache ~1h in ~/.cache/harnes/openrouter-models.json. Offline fallback: keep a static curated list.
2. Map each OpenRouter model to Harnes ModelSpec: id, name, openrouterModel (the slug), providerModel, minContext from context_length, toolCalling reliable|experimental|unreliable.
3. Keep reject list for tiny/unreliable models (gpt-oss:20b, tinyllama, etc.).
4. getModel() must resolve OpenRouter slugs (anthropic/claude-sonnet-4.5) and Harnes ids.
5. Router still has fast-open / strong-open / frontier-byok defaults. Prefer coding-capable models (Qwen Coder, DeepSeek, Claude, GPT, Gemini, Llama 70B+). allowFrontier remains off by default.
6. Export listOpenRouterModels() for /models later. Keep wireModelId().
7. Tests: cache fallback, slug lookup, rejects weak ids, router still returns strong-open for build.

Do not reintroduce OpenHost. Do not change the REPL UI.
```

---

## Do not reintroduce
- OpenHost, E2B, `harnes host`, `OPENHOST_*`
- GitHub clone installers

## Product
- Bare `harnes` = persistent REPL
- `/mode auto|plan|build` `/model` `/status` show context window
- OpenRouter when `OPENROUTER_API_KEY` is set
