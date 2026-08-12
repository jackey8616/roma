# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

**Unless you're in a Claude Code cloud container**, where `gh` doesn't exist — see
[Running in a Claude Code cloud container](#running-in-a-claude-code-cloud-container)
for the GitHub MCP equivalents and the three operations that have none.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`, or in a cloud container `issue_read` `get` followed by
`issue_read` `get_comments`.

## Running in a Claude Code cloud container

Verified 2026-07-28 in a Claude Code on the web container (agent `claude-code_2-1-220`), and
re-verified 2026-07-30 in the same kind of container. What changed on re-verification is
marked below.

`gh` is **not installed** there — `which gh` returns nothing — so every `gh` command in this
document fails with `command not found`. GitHub access goes through the **GitHub MCP server**
instead: tools named `mcp__github__*`.

**Probe with `which gh`, and with nothing else.** Corrected 2026-07-30: `GH_TOKEN` and
`GITHUB_TOKEN` are now **both set**, which the 2026-07-28 note said they were not. Neither is
a credential — each holds the same 14-character placeholder the outbound proxy injects — so a
probe written as `[ -n "$GH_TOKEN" ]` now reports that `gh` will work, and it will not.

| Operation | Local (`gh`) | Cloud container (MCP) |
| --- | --- | --- |
| Create an issue | `gh issue create` | `issue_write` with `method: "create"`, plus `title` / `body` / `labels` |
| Read an issue | `gh issue view <n>` | `issue_read` with `method: "get"` |
| Read its comments | `gh issue view <n> --comments` | `issue_read` with `method: "get_comments"` — a **second** call; `get` doesn't include them |
| Read its labels | `--json labels` | the `labels` array on `get`, or `issue_read` `method: "get_labels"` |
| List issues | `gh issue list --state open --label X` | `list_issues` with `state: "OPEN"`, `labels: ["X"]` |
| Search issues | `gh issue list --search ...` | `search_issues` (already scoped to `is:issue`) |
| Comment | `gh issue comment` | `add_issue_comment` |
| Apply / remove labels | `gh issue edit --add-label` / `--remove-label` | `issue_write` `method: "update"` with the **complete** `labels` array — it replaces, it doesn't merge, so read the current labels first |
| Claim | `gh issue edit <n> --add-assignee @me` | `issue_write` update with `assignees: ["<login>"]`; `@me` is not understood — resolve the login with `get_me` |
| Close | `gh issue close <n> --comment "..."` | `add_issue_comment`, then `issue_write` update with `state: "closed"` and a `state_reason` |
| Sub-issues | `gh api .../sub_issues` | `sub_issue_write`; read with `issue_read` `get_sub_issues` / `get_parent`. Needs a database id — see below |

Every row above was run on 2026-07-30 except the sub-issues one, which was not.

Every MCP call takes explicit `owner` and `repo` — there is no "infer it from the clone" the way
`gh` does. Read them out of `git remote -v` (here: `jackey8616` / `roma`).

`list_issues`, `search_issues` and `list_releases` take a `fields` array that trims the response.
Passing `["number", "title", "state", "labels"]` drops the bodies, which is the difference between
reading a backlog and filling a context window with it.

### What the MCP server can't do

Two things this document asks for have **no** cloud-container equivalent. Both re-checked
against the server's tool list on 2026-07-30:

- **`gh api` passthrough.** There is no generic REST or GraphQL escape hatch. Any step written
  as `gh api <endpoint>` simply cannot be performed.
- **Issue dependencies.** Nothing wraps `issues/<n>/dependencies/blocked_by`, and no tool returns
  `issue_dependencies_summary`. Use the fallback this document already specifies — a
  `Blocked by: #<n>` line in the child body — and compute blockedness by reading each referenced
  issue's `state`. This repo's existing tickets (#9–#13) are already written that way, so in a
  container the fallback is the normal path, not a degraded one.

#### Corrected 2026-07-30: the database id is reachable after all

This section used to list a third impossibility — resolving an issue's numeric database id,
which `sub_issue_write` wants as `sub_issue_id` and which is *not* the `#number`. That was
wrong, and it cost this repo native sub-issues for two days.

**`issue_write` returns it.** Both methods do: `create` answers with the new issue's `id`, and
`update` answers with the target issue's `id`. So a child created in the same session can be
attached to its parent immediately, using the id its own creation handed back.

What is genuinely unavailable is a **read-only** path to it. `issue_read` `get` returns `number`
and no `id`, and `search_issues` does not offer `id` even as an option in its `fields` enum. To
learn the id of an issue this session did not create, the only route is an `issue_write` update
— a write, which touches `updated_at`.

**Run 2026-08-12: `sub_issue_write` works, and the create-then-attach path is the whole of it.**
This paragraph used to say the tool was unrun and to delete the sentence once somebody had
actually attached a child; #182 is that, eight times over. What was run: `issue_write` `create`
for the map, then `issue_write` `create` for each child, then `sub_issue_write` `method: "add"`
with `issue_number` set to the map's `#number` and `sub_issue_id` set to the **`id` the child's
own create returned**. Each call answers with the *parent*, whose `sub_issues_summary.total`
counts up — which is how you check the attachment landed without a second read.

So the read-only gap above is real and does not bite: a session that creates both ends never
needs to look an id up. It bites only where the child already exists and this session did not
make it, which is the case that still costs an `issue_write` update.

One thing that was **not** run: `remove` and `reprioritize`. Children arrive in the order they
are added, which is enough to keep a map in dependency order if they are created that way, and
nobody has yet needed to reorder one.

One thing that's merely more expensive: `gh issue list --json body,labels,comments` returns
everything in one shot, while `list_issues` returns no comments. `/triage` therefore needs one
extra `issue_read get_comments` per issue — batch 5–10 issues at a time rather than pulling the
whole backlog.

For PRs the shapes are `list_pull_requests`, `pull_request_read` (`get`, `get_diff`,
`get_comments`, `get_reviews`), and `add_issue_comment` with the PR number. Untested here, since
this repo has PR triage switched off — if you turn that flag on, confirm whether
`authorAssociation` is reachable before relying on the external-contributor filter above
(`issue_read` `get` does return `author_association` for issues).

### Repo scope

A session can only reach the repositories attached to it. `mcp__github__*` calls against any
other repo are denied no matter what the underlying token is allowed to do, and the repo has to
be attached to the session before it can be read or written.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

This section leans on `gh api` for sub-issues and dependencies, so it is the part that degrades
most in a cloud container — but less than it used to. **Dependencies** have no equivalent: take
the `Blocked by: #<n>` body-text fallback described below, which is what this repo already uses.
**Sub-issues** are reachable, via the database id `issue_write` hands back on create, and #182 is
a map built that way in a container; the `Part of #<map>` line stays worth writing regardless,
since it is what a reader sees.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
