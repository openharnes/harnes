# Tool-call + outcome evals

τ-bench is a **customer-service domain simulator** — wrong fit for a coding agent.
Harnes ships an in-repo suite that:

1. **Loop mode (default `--live`)** — runs the real agent loop in a temp workspace, tools execute, then scores **trajectory tool calls + post-run outcome checks**.
2. **First-step mode (`--live --first-step`)** — BFCL-style single completion, no tool execution (call-name accuracy only).
3. **Fixture mode (no `--live`)** — offline goldens for the tool scorer (CI).

## Layout

| Path | Role |
|------|------|
| `evals/tasks/*.json` | Prompts, expect[], setup files, outcome checks |
| `evals/fixtures/goldens.json` | Offline recorded `actual[]` |
| `src/eval/score.ts` | Tool-call scorer |
| `src/eval/outcome.ts` | Post-loop file/final checks |
| `src/eval/runner.ts` | Load tasks + live/offline run |

## Task schema

```json
{
  "id": "edit_not_write",
  "prompt": "In package.json, change description to eval-marker-description using edit_file…",
  "expect": [{ "name": "edit_file" }],
  "setup": {
    "files": { "package.json": "{ \"description\": \"old\" }" },
    "gitInit": false
  },
  "checks": [
    { "type": "file_contains", "path": "package.json", "text": "eval-marker-description" }
  ],
  "maxSteps": 8,
  "tags": ["edit", "outcome"]
}
```

**Check types:** `file_contains` · `file_equals` · `file_exists` · `file_not_exists` · `final_contains` · `final_matches` (regex)

- `expect: []` → abstain (no tools in the trajectory).
- Loop score = average of tool recall + check pass rate when both are present.
- Extra unexpected tool calls do not fail if every expected call matched.

## Commands

```bash
# Offline scorer goldens
npm run harnes -- eval

# Live loop + outcomes (default)
npm run harnes -- eval --live
npm run harnes -- eval --live --task read_file_index,edit_not_write
npm run harnes -- eval --live --model qwen3-coder-30b

# Live first-step only (no tool execution)
npm run harnes -- eval --live --first-step
```

Exit code `1` when any task fails.
