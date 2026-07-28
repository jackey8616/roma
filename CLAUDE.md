# something

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
