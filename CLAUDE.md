# something

## Building and testing

Node 22 (`.nvmrc`), TypeScript, Vitest. `npm test` is the default run — fast, free, and
safe to run as often as you like.

**`npm run test:seam2` spends real money.** It drives a real `claude -p` against the
Shared Window everybody shares. Run it when you have changed something the stream contract
depends on, not as a matter of course. It lives in its own Vitest config so `npm test` can
never reach it, and it needs `CLAUDE_CODE_OAUTH_TOKEN` in a `.env` at the repo root.

See `README.md` for the rest, and `test/fixtures/claude-stream/README.md` for what the
recorded streams are and where they came from.

## Agent skills

The `mattpocock/skills` set is vendored into `.claude/skills/` as editable files, installed with
`npx skills@latest add mattpocock/skills` and pinned by `skills-lock.json`. Pull upstream changes
with `npx skills update`; local edits are ours to keep.

### Issue tracker

Issues live in this repo's GitHub Issues, managed via the `gh` CLI — or the GitHub MCP tools when
`gh` is absent, as in a Claude Code cloud container. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings. See `docs/agents/triage-labels.md`.

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) — `type(scope): subject` in
the imperative, with a body explaining *why*. PRs land by **squash merge**, and only when the
user asks for the merge. See `docs/agents/commit-convention.md`.

### Domain docs

Single-context — one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
