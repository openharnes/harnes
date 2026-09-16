# Skills

Skills are short markdown files the agent can pull into context by name,
instead of paying for them in every prompt. They're plain instructions —
"how we write commit messages here," "the checklist for touching the billing
code," etc.

## Layout

Harnes looks in two places, workspace first:

```
.harnes/skills/<name>.md                 # workspace-local, checked into the repo
~/.config/harnes/skills/<name>.md        # user-level, shared across projects
```

A workspace skill shadows a user-level skill with the same name. Any `.md`
file in either directory is a skill; the filename (minus `.md`) is its name.

## Using a skill

The model has a `skill` tool:

- `skill` with no arguments — lists every skill visible from the current
  workspace (name only).
- `skill` with `name` set — loads that skill's markdown body into context.
  Bodies over 8,000 characters are truncated with a `... truncated N
  characters ...` marker.

`skill` is read-only: it's allowed in both `plan` and `build` mode and never
prompts for approval.

## Example

```
mkdir -p .harnes/skills
cat > .harnes/skills/commit-style.md <<'EOF'
# Commit style

- Imperative mood, present tense ("add", not "added").
- One logical change per commit.
- No AI attribution unless the project asks for it.
EOF
```

The model can then call `skill` with `name: "commit-style"` to load it, or
call `skill` with no arguments first to see what's available.

## Hooks

`preToolUse` / `postToolUse` hooks are thin, best-effort observation points
around every tool call. Configure them under `hooks` in
`~/.config/harnes/config.json`:

```json
{
  "hooks": {
    "preToolUse": [{ "match": "bash", "command": "echo about to run bash >> /tmp/harnes-hooks.log" }],
    "postToolUse": [{ "command": "cat >> /tmp/harnes-hooks.log" }]
  }
}
```

- `match` is a tool name (e.g. `"bash"`, `"edit_file"`); omit it or use
  `"*"` to match every tool.
- `command` runs via the shell; it receives the event payload (tool name,
  arguments, and — for `postToolUse` — the result) as JSON on stdin.
- Hooks are fire-and-forget: a failing or slow hook (5s timeout) is logged
  to stderr and never blocks or fails the tool call it wraps.

Embedders running Harnes as a library can also register in-process JS
handlers via `registerHook("preToolUse" | "postToolUse", handler)` from
`src/hooks.ts` instead of shelling out.
