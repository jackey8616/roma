# Commit Convention: Conventional Commits

Every commit in this repo follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
Agents write commits here too — this is the format to use without asking.

```
<type>(<scope>)!: <subject>

<body>

<footers>
```

Only `<type>` and `<subject>` are required. History before this document predates the
convention; don't rewrite it, just start here.

## Subject line

- **Type and scope in lowercase**, then `: `, then the subject.
- **Imperative mood** — "add", "document", "vendor", not "added" / "adds" / "adding".
  The existing history already reads this way; the type prefix is what's new.
- **No trailing period**, no capital first letter on the subject.
- **Keep it under 72 characters.** If it won't fit, the detail belongs in the body.

## Types

| Type       | Use it for                                                                     |
| ---------- | ------------------------------------------------------------------------------ |
| `feat`     | A new capability — a new skill, a new agent workflow, a new command             |
| `fix`      | Correcting behaviour that was wrong, including wrong instructions in a doc      |
| `docs`     | Documentation whose content is the point: ADRs, `CONTEXT.md`, `docs/agents/`    |
| `refactor` | Restructuring with no change in behaviour or instruction                        |
| `test`     | Adding or correcting tests                                                      |
| `perf`     | A change made for performance                                                   |
| `build`    | Dependencies, lockfiles, packaging — including `skills-lock.json` bumps         |
| `ci`       | GitHub Actions and other automation config                                      |
| `chore`    | Housekeeping that fits nothing above (`.gitignore`, file moves, renames)        |
| `revert`   | Reverting an earlier commit; name it in the body                                |

Since this repo is mostly prose and agent configuration, `docs` and `chore` carry most of
the traffic. Prefer the more specific type when both fit: a doc that *corrects a wrong
instruction* is a `fix`, not a `docs`, because a reader following the old text got the
wrong result.

## Scopes

Optional, but use one when the change sits in a recognisable area:

| Scope     | Area                                             |
| --------- | ------------------------------------------------ |
| `skills`  | `.claude/skills/` and `skills-lock.json`         |
| `agents`  | `docs/agents/`                                   |
| `adr`     | `docs/adr/`                                      |
| `context` | `CONTEXT.md` and the domain model                |
| `claude`  | `CLAUDE.md`                                      |
| `core`    | `src/` — the Channel-independent part of roma    |
| `chat`    | `src/channels/google-chat/` — the Chat Adapter    |
| `infra`   | `infra/` — the Terraform somebody runs by hand    |
| `image`   | `Dockerfile`, `.github/` and `scripts/` — how roma is built, checked and shipped |

Invent a new scope when a change genuinely introduces a new area, and add it here in the
same commit. Don't stretch an existing scope to cover something it doesn't describe, and
drop the scope entirely when a change spans several.

## Body

The body is where this repo's standard is high — keep it that way. Blank line after the
subject, wrapped at ~80 columns, and it should answer **why**, not restate the diff:

- What was wrong, or what assumption changed.
- What was chosen and what was rejected, with the reason.
- Anything a future reader would otherwise have to rediscover — a verification date, a
  silent failure mode, a constraint that forced the design.

A one-line change to a typo needs no body. Anything that involved a decision does.

## Breaking changes

Put a `!` before the colon **and** a `BREAKING CHANGE:` footer explaining the migration:

```
feat(agents)!: replace the gh CLI workflow with GitHub MCP

BREAKING CHANGE: skills that shell out to `gh issue view` now fail in cloud
containers. Use `issue_read` with `method: "get"` instead — see the mapping
table in docs/agents/issue-tracker.md.
```

For this repo, "breaking" means a skill or workflow that followed the old instructions
stops working — not just that a file changed. A deployment that must do something before
upgrading counts, and so does one that will lose state by doing nothing.

**The footer is what a release note is built from**, which is the reason to be strict
about it rather than a style point. `docs/agents/release-notes.md` reads this range for
`!` and `BREAKING CHANGE:` to decide whether a version needs an upgrade block.

This has been missed once, and it was the only chance to get it right. 0.5.0 moved
`infra/variables.tf`'s `service_account_id` default from `roma-agent` to `roma-runtime`
— a Google Cloud account id is immutable, so a plain `terraform apply` destroys and
recreates the service account, its key, and every grant bound to it. It landed as
`feat: roma mints the agent's Cloud Token (#99)`: no `!`, no footer, and one bullet 41
lines into the body. The tag body caught it because a person wrote 1958 words by hand.
Nothing else would have.

## Footers

- **Issues**: `Closes #12`, or `Refs #12` when the commit advances a ticket without
  finishing it. Sub-issue and blocking relationships live in the issue bodies, per
  `docs/agents/issue-tracker.md` — don't duplicate them here.
- **Co-authors**: `Co-Authored-By: Name <email>`, one per line.
- **Reverts**: name the reverted subject and short SHA in the body.

## Examples

From this repo's own history, restated in the convention:

```
docs(agents): document the GitHub MCP path for cloud containers
```

```
build(skills): vendor mattpocock/skills into the repo
```

```
docs(adr): add ADRs for the Google Chat to Claude Code bridge
```

```
fix(agents): correct the sub-issue id the MCP tools require
```

## Merging

**Squash merge, always.** A PR lands on `main` as exactly one commit, so `main` reads as
one convention-shaped commit per change rather than a mix of merge commits and work in
progress. (`main` currently carries one merge commit, from before this rule — leave it.)

- **Locally**: `gh pr merge <n> --squash`
- **In a cloud container**: `merge_pull_request` with `merge_method: "squash"`

**Agents don't merge on their own.** Opening a PR is not permission to land it — merge only
when the user asks for it in that turn, and then use squash.

The squash commit is a real commit and takes the full convention:

- **Subject**: the PR title, which should already be `type(scope): subject`. GitHub appends
  ` (#15)`; that's expected and doesn't count against the 72 characters.
- **Body**: write it. GitHub's default is a bulleted list of the branch's commit subjects,
  which throws away the reasoning that made those bodies worth reading. Where the branch is
  a single commit, reuse its body; where it's several, write one body that says why the
  change as a whole exists.
- **Footers**: carry `Closes #n` and every `Co-Authored-By` from the branch onto the squash
  commit — they're lost otherwise.

## Enforcement

None — no commitlint, no hook. The convention is upheld by whoever (or whatever) writes
the commit. If a commit lands off-convention, leave it; don't rewrite pushed history to
fix a prefix.
