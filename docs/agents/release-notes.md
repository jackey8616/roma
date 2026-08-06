# Release Notes: what a tag says

A release note answers one question — **what does somebody moving from the last version
to this one need to know?** Nothing else belongs in it.

This is the one document in the repo where **short is the standard**, and it is
deliberately not the standard `docs/agents/commit-convention.md` sets. A commit body
earns its length by explaining a decision to whoever reads the diff in a year. A release
note is read once, by somebody with a running deployment, who wants to know whether they
can change the image tag and walk away.

The measurement that prompted this: 0.5.0's tag body ran to 1958 words, of which the part
that mattered — pin `service_account_id` before `terraform apply`, and
`ROMA_CLOUD_KEY_FILE` is optional — was four sentences. The rest re-narrated ADR-0013,
ADR-0014 and ADR-0015, which were already in the tree and are better there. 0.6.0 came
in at 706 and 0.7.0 at 1159, so the pull is real and it is toward length.

**Everything else already has a home.** The reasoning is in `docs/adr/`. What to
configure is in `README.md`. The by-hand cloud setup is in `infra/README.md`. A release
note that restates any of them is a second copy of a fact, and the copy that goes stale
is always the one nobody edits again. Cite them; never restate them.

## Shape

Three parts, in this order, and two of them are often absent:

```markdown
roma 0.5.0

**Before you upgrade: pin `service_account_id = "roma-agent"` in
`terraform.tfvars`.** The default moved to `roma-runtime`, and a Google Cloud account
id is immutable — a plain `terraform apply` destroys and recreates the service account,
its key, and every grant bound to it, including the `pubsub.subscriber` roma's ingress
runs on. (ADR-0015)

`ROMA_CLOUD_KEY_FILE` is new and optional. Unset, roma starts exactly as 0.4.0 did —
see README.md.

- roma mints the agent's Cloud Token (ADR-0015, #99)
- an Enclosure lands on disk named by roma (ADR-0011, #92)
- a Conversation says which model its Session runs on (ADR-0014, #86)
- `/clear` and `/reset` are roma's reset (ADR-0013, #87)
- a nearly-spent Shared Window no longer reads as spent (#83)
```

**1. The upgrade block, when a deployment must do something.** Hand-written, and the
only part that is. It must carry a **verb, an object, and a consequence** — what to
type, where, and what happens if you do not. `See ADR-0015` is not an upgrade block:
`README.md` describes the system as it is now and will never say "if you are coming from
0.4.0, do this first", so the transition has no other home. The link goes at the end and
supplies only the *why*.

If nothing must be done, say so in one line — `**Nothing breaks.** An 0.6.0 deployment
upgrades by changing the image tag.` — and stop. That line is worth writing, because its
absence is not distinguishable from somebody forgetting.

**2. New optional configuration, when there is any.** One or two sentences, pointing at
`README.md` for the detail. What matters here is only whether an existing deployment is
affected by not setting it.

**3. The summary, one line per user-facing change.** Mechanical (see below). No
paragraph under a bullet — if a change needs a paragraph, it either belongs in the
upgrade block or it belongs in an ADR that the bullet cites.

Write it as plain Markdown with inline references — `(ADR-0015, #99)`. **No
reference-style links.** The same text is the annotated tag message, where
`[ADR-0022][adr-0022]` renders as literally that and the definitions pile up at the
bottom saying nothing.

## Where the lines come from

The summary is derived, not composed. Start from the subjects:

```sh
git log --format='%s' <previous-tag>..HEAD
```

Keep `feat`, `fix` and `perf`. Drop `docs`, `test`, `build`, `ci`, `chore`, `style` and
`refactor` — a refactor that changed behaviour was mistyped, and that is a commit
convention problem, not something to repair at release time. In 0.6.0…0.7.0 that filter
takes 13 commits down to 2.

Rewrite each kept subject into roma's own vocabulary if it is not already there, and
append its ADR and PR. Do not expand it. The subject was written under a 72-character
limit by somebody who had just done the work, and that constraint is the reason this
part cannot run long.

## Finding what must be said out loud

The signal is the commit convention's own:

```sh
git log --format='%s' <previous-tag>..HEAD --grep='^BREAKING CHANGE:'
git log --format='%s' <previous-tag>..HEAD | grep '!:'
```

**Do not trust it alone yet.** The one release with a real deploy-breaking change —
0.5.0's service account rename — carried neither marker. It landed inside
`feat: roma mints the agent's Cloud Token (#99)`, mentioned once in the commit body's
41st line, with no `!` and no footer. The hit rate is 0 for 1, so also read the
operator-facing diff, which is three paths and bounded:

```sh
git diff --stat <previous-tag>..HEAD -- README.md infra/ Dockerfile
```

Anything there that changes a name, a default, or a required variable needs an upgrade
block. `infra/variables.tf` is what would have caught 0.5.0.

When you find one this way, the repair belongs in the commit, not here — see
`docs/agents/commit-convention.md`.

## Cutting the release

One text, written once, used twice. It is the annotated tag message *and* the GitHub
Release body; they never diverge because there is only one of them.

1. Write the note to a file — `.tmp/notes.md` or anywhere untracked.
2. `git tag -a -F <file> <version> && git push origin <version>`
3. **Wait.** The push starts `.github/workflows/release.yml`, which builds, tests,
   verifies and pushes the image to GHCR. Watch it with `actions_list` /
   `get_job_logs`.
4. **Green** — open the Release from the same file:
   - locally: `gh release create <version> --notes-file <file> --verify-tag`
   - in a cloud container, where there is no `gh` and the GitHub MCP tools are read-only
     for releases: `POST /repos/{owner}/{repo}/releases` with `curl` and `$GH_TOKEN`,
     body `{"tag_name": "<version>", "name": "<version>", "body": "<the file>"}`
5. **Red** — stop. No Release. A red run means the image is not on GHCR, and a Release
   is an outward-facing announcement that notifies people; announcing an image nobody
   can pull is worse than announcing nothing. Fix, and re-tag.

The tag comes first and carries the note on its own, so a failure between steps 2 and 4
leaves the record in git rather than nowhere.

## What this is not

**Not generated end to end.** Every changelog generator — git-cliff, release-please,
release-drafter, GitHub's own auto-generated notes — builds the note from commit
subjects and PR labels. Against 0.4.0…0.5.0 they all produce
`### Features — roma mints the agent's Cloud Token (#99)` and the destroy-and-create
warning disappears, because it was never in a subject, a label or a footer. The summary
is mechanical precisely so the human effort can go to the part no tool can reach.

**Not a job for `release.yml`.** That workflow builds and publishes the image; giving it
`contents: write` so it could open Releases too would widen the permissions on the one
path in this repo that does something irreversible, to save a step an agent is already
present for.

**No ADR.** A release note format is cheap to change — the next release simply uses the
new rule — and `docs/agents/domain.md` reserves ADRs for decisions that are hard to
reverse. The reasoning that would have gone in one is above.
