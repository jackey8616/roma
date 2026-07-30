# 8. The agent clones, roma only mints

Date: 2026-07-30

## Status

Accepted, and **built** — the first slice of it, in #60. This was written as an
unimplemented design settled in one sitting, so that the code that followed had
something to disagree with; what the code disagreed with is noted inline below
and in the paragraph after next.

Everything in *Decision* now exists in `src/` except the `Requested-by:` trailer
and the Audit Record gaining the repositories a Task minted for, both of which
were deliberately left out of the first slice and have tickets of their own.
What is still true of the whole of it is the last Consequence: almost none of it
has been measured against a real App. `docs/github-app-verification.md` is the
list, and it is honest about being unrun.

**Amended 2026-07-30**, before any code, which is earlier than that sentence
expected. Two things did not need code to disagree with them: a statement of
fact that a five-minute measurement contradicts, and a tool this ADR never
considered. The decisions are unchanged — one of them is now held up by a
different reason, and the mechanism under another is larger than described.
Amendments are marked inline. Everything settled in the same session that is
genuinely *new design* is deliberately **not** here: it is unbuilt, and putting
it in an ADR would repeat the failure the paragraph above is an apology for.

Extends ADR-0002 rather than reversing it: the same problem — everybody shares
one credential, so the provider knows only that somebody spent it — arrives a
second time on a second provider, and gets a second answer here.

## Context

roma today cannot see a line of anybody's code. `SessionPool` gives each Session
an empty directory under `ROMA_WORK_ROOT` (`src/session-pool.ts:489`) and puts
nothing in it. `buildEnv` admits six host variables and refuses the rest, on
purpose. The image installs `git` — `Dockerfile:51` says "because that is what
the agent is for" — and then hands it no credential, so what the agent is for is
something it cannot do.

The gap is not subtle and it is not new. What made it worth a decision rather
than a patch is that closing it moves several things that were carefully placed:
the credential isolation ADR-0002 built, the attribution ADR-0002 settled, the
Working Directory lifetime ADR-0006 justified, and the Core's freedom from
product names that `src/core.test.ts` enforces.

A GitHub App is the mechanism throughout. That much was never in question. What
follows is everything that was.

## Decision

### The App is the agent's hands, not a road

GitHub is not a Channel here. Nobody talks to roma through it; roma reaches
*out* through it. A Channel Adapter turns a product's events into Ingress
Messages, and this turns no events into anything — so none of the Channel
vocabulary applies, and `src/channels/` is the wrong place for it.

GitHub as a second road is a real idea and a separate one. It is not decided
here and nothing here forecloses it.

### roma does not know which repository a Conversation is about

There is **no binding** between a Conversation and a repository. No Command sets
one, nothing is written down, and roma performs no checkout. The Working
Directory is still created empty and `SessionPool` is untouched. The agent runs
`git clone` for whatever it was asked about, and the credential is simply there
when git asks for it.

This was the decision with the most given up, and the reason it is written down.
The alternative was available and cheap: a GitHub App installation token can be
**down-scoped at mint time** to a named subset of repositories
(`POST /app/installations/{id}/access_tokens` takes `repositories` and
`permissions`). Had roma known the repository, every Conversation could have run
on a token that reached only that one.

It does not, so it cannot. **The blast radius of every Conversation is the whole
Installation**, and every Workspace member who can reach roma has it. That is
recorded as a property of the design rather than as an oversight.

**Amended — "it does not" is false, and the decision now rests on something
else.** roma does learn the repository, at the only moment that matters. With
`credential.useHttpPath` set, `git` names it on every credential request — which
is the same fact this ADR already spends further down, where the Audit Record
gets the repositories a Task minted for "for free". Both cannot be true, and the
one that survives is the one that was measured: `git` 2.43.0, a real clone of a
repository that requires authentication, the helper receiving

```
protocol=https
host=github.com
path=jackey8616/a-repo-that-does-not-exist-9f3a.git
```

before any credential was supplied. Down-scoping at mint time was therefore on
the table after all, and was reconsidered rather than left buried.

It is still declined, for a reason that did not exist when this was written:
`gh` is in scope now (see the amendment under *minted on demand*), and **`gh`
announces no repository** — `gh api graphql` and `gh search` have none to
announce, and inferring one from `argv` or the working directory is a guess whose
failures surface as unexplained 404s inside somebody's Turn. The Credential Shim
in front of `gh` must hand out a token for the whole Installation, and an agent
that can invoke that Shim can obtain one whenever it likes. Scoping `git`'s side
alone would bound accidental leakage on one path while the other stayed wide
open, and would be read a year from now as a boundary it never was — the precise
mistake the *not a boundary against the agent* paragraph below exists to prevent.

So the blast radius above stands, and the reason for it is no longer ignorance.

What it buys is that roma acquires no new state, no new Command, no lookup, and
no checkout policy — and Claude Code's own judgement about what to clone is not
second-guessed by a worse copy of it in roma.

### The Installation Token is minted on demand, never held

The credential reaches the agent through a **git credential helper**, and the
choice is forced by arithmetic rather than by taste: an installation access token
**expires after an hour**, and a process environment is fixed at spawn. A
Resident Session outliving an hour is ordinary — reaping is fifteen minutes of
*idleness*, not a lifetime — so a token in `buildEnv` is not the simple version,
it is the version that dies mid-Turn.

`GIT_CONFIG_GLOBAL` points at a gitconfig roma writes, which sets
`credential.helper` and `credential.useHttpPath`. The helper is a thin client. It
holds no secret and mints nothing; it asks roma, over a local channel, and roma —
which holds the App private key — mints and answers.

**The private key never enters the container's reachable space.** A key in the
agent's reach would turn a one-hour exposure into a permanent, indefinitely
renewable one, which is worse than the personal access token this whole
arrangement exists to avoid. This is the one line here with no trade-off behind
it.

**Amended by #60 — this sentence is false as built, and the code did not make it
true.** roma spawns Claude Code as a child process, so roma and the agent are the
same container and the same uid by construction; the key is a mounted file a
shell can read. Nothing in the first slice could have changed that, and nothing
short of running the agent somewhere else can. What is left doing the work is the
one-hour expiry, which bounds a token that escapes and is unaffected by the key.
`docs/github-app-verification.md` records the gap; it is not treated as met.

It must also be said plainly, because a credential helper is easily sold as
security it is not: **this is not a boundary against the agent.** The agent has a
shell under `bypassPermissions`; `git credential fill` prints the token. What the
helper buys is freshness against the one-hour clock, and keeping the token out of
the process environment — where `env`, a stack trace, or a diagnostic command
would write it into a **Transcript roma has promised never to delete**
(ADR-0006). The hour is what bounds that; nothing longer-lived than an hour could
be allowed anywhere near an append-only record.

**Amended — one helper is not the whole mechanism, because `gh` is not `git`.**
Issues and pull requests are a good part of what this exists for: `issues: write`
is granted below on the grounds that "file that as an issue" is among the first
things anybody will ask, and this repository's tracker *is* GitHub Issues
(`CLAUDE.md`). That work is done with `gh`, and **`gh` has no notion of a
credential helper.** It takes a token from `GH_TOKEN`, or from a config file it
was logged into — the process environment this section rejects on arithmetic, and
a file the Alternatives below reject on the same expiry. Implemented exactly as
written, an agent could clone and push and could not open a pull request, which
is not a shortfall anybody would accept as the design.

The mechanism is therefore one **Minter** and **two Credential Shims**, both
named in CONTEXT.md: `git`'s credential helper, and something ahead of `gh` on
`PATH` that mints per invocation and passes the token to that one child process
and no other. Per invocation rather than per Session, for this section's own
arithmetic — an environment fixed at spawn is stale within the hour, and a
Resident Session outliving an hour is ordinary.

The GitHub MCP server was considered in `gh`'s place and is worse here rather
than better: its token is an environment variable read at launch, and an MCP
server is started once per Session and then stays. It is `GH_TOKEN` at spawn with
an extra process in front of it.

What none of this changes: a Shim is still not a boundary against the agent, for
the reason two paragraphs up. It has only stopped being singular.

### What the Installation may do

`contents: write`, `pull_requests: write`, `issues: write`, `workflows: write`,
`actions: read`, `metadata: read`.

`issues: write` because this repository's issue tracker *is* GitHub Issues
(`CLAUDE.md`), so "file that as an issue" is among the first things anybody will
ask, and it moves no code.

`workflows: write` is the one that was argued. Without it GitHub refuses, at push
time and by name, any commit touching `.github/workflows/**` — a loud and
specific failure, and a case for leaving it off. It is on anyway, deliberately:
"fix the CI" is work roma is expected to do. The cost is in Consequences and is
not small.

Not here, and deliberately: whether the agent may push to a default branch. That
is branch protection's question, it lives on the repository, and it answers the
same way for a person and for a bot. Expressing it as a missing permission would
put the rule in the wrong place and take it away from humans too.

### A commit says who asked, twice

Every commit, PR and comment is the App's. The person who asked is recorded in
two places, neither of them the author field.

**On the artifact**: a `Requested-by:` trailer, in the Channel's own terms
(`Requested-by: alice@example.com (google-chat)`), appended unconditionally by a
`prepare-commit-msg` hook via `core.hooksPath`. Not `commit.template`, which
applies only to interactive commits with no `-m`, and the agent always passes
`-m`. Like the helper, this is for honesty and not for enforcement — an agent
with a shell can defeat it, and the point is that the ordinary path records the
truth.

The gitconfig and hook are rewritten at the start of each Task, because a Chat
space is many people sharing one Conversation and therefore one Session, so the
asker changes between Turns of one process. There is no race: the Task Queue
already serialises the Tasks of a Session.

**Putting the asker in the commit author was rejected on a fact, not a
preference.** roma holds a Channel identity — a Google account. It does not hold
that person's GitHub identity and has nowhere to get one. Mapping between them is
a lookup table, which is precisely the database roma does without and which
`session-generation.ts` goes out of its way to say it is not.

**In the audit log**: an Audit Record gains the repositories that Task minted a
token for. Not what it pushed — roma does not know that, and the two ways to
learn it are parsing shell commands out of the event stream or reading the
Transcript, which CONTEXT.md says roma does not do. The credential helper knows
the honest version for free: with `credential.useHttpPath` set, git tells it the
path every time it asks.

The Audit Record rather than the Operator Log, although "a credential swap" is
listed in the Operator Log's own definition. The Operator Log is explicitly not
totalled, and "whose Tasks touched `infra` last month" is a question only
something totalled can answer.

### GitHub is required

`ROMA_GITHUB_APP_ID` and `ROMA_GITHUB_PRIVATE_KEY_FILE` join the variables roma
refuses to start without, named in the same single refusal as the rest. Not the
Overflow shape (optional, but refused if half-configured) — roma without GitHub
is not a roma anybody wants running.

A file path rather than an inline PEM, following `GOOGLE_APPLICATION_CREDENTIALS`
— multi-line secrets belong in mounts.

No installation id variable. `GET /app/installations` lists them: exactly one is
used, and more than one is **refused at startup with all of them named**, because
roma refuses rather than guesses.

Startup calls `GET /installation/repositories` before anything that could accept
an Ingress Message exists, and a failure blocks the boot — the Startup
Self-Check's shape, for the Startup Self-Check's reason. A bad private key that
surfaced instead as an inexplicable `git clone` failure inside somebody's Turn
would read as "roma is broken" with no diagnosis attached. Unlike the Claude
self-check, this one is free.

### The agent is told what it has

That same startup call returns the repository list, and it is injected into every
Session with `--append-system-prompt`: that git credentials are present, and
which repositories they reach. A capability nobody knows about is a capability
nobody has, and Claude Code in an empty directory has no reason to believe it can
clone anything.

`--append-system-prompt` rather than a `CLAUDE.md` written into the Working
Directory. That directory is the agent's workspace; it clones into it and runs
`git add -A` in it, and a file roma left there will eventually be committed into
somebody's repository.

The list goes stale if the App is installed somewhere new — but softly. The token
already covers the new repository, so cloning it works; only roma's advertisement
is behind, and only until the next restart.

### One narrow port, one directory, one guard of its own

GitHub-specific knowledge — App id, JWT, REST — lives in `src/github/`. The Core
sees a narrow port for obtaining a credential and nothing else.

The justification is the testing seam, not a hypothetical GitLab. README already
states the pattern: the two things that cannot be tested "live behind a port — so
what is untested is the edge rather than anything that decides something." A
GitHub REST call is a third such thing, and behind a port `wiring.test.ts` can
still assemble roma out of real parts, and seam 1 stays free and deterministic.

`github` is **not** added to `src/core.test.ts`'s Channel denylist. That test
says "never names a **Channel** anywhere in the Core", and its comment explains
itself in terms of "Google Chat is the first road, not the destination". GitHub
is not a road, and smuggling it in would make that comment untrue. Containment
gets a **second test of its own**, with its own reason: GitHub is named only
under `src/github/`.

### Reclaiming a Working Directory can now cost work

The behaviour does not change: seven idle days and it goes, unexamined.

What changes is that CONTEXT.md's justification for it — "losing this one costs a
checkout" — has stopped being true, and is corrected rather than left standing. A
Working Directory can now hold work an agent did and never pushed, and the
Transcript's account of it is prose, not a diff.

Refusing to reclaim a dirty tree was rejected: it trades a bounded disk cost for
an unbounded one, and nobody ever comes back to clean up the tree that was
spared.

## Consequences

- **`workflows: write` under `bypassPermissions`, with no egress allowlist, is a
  real escalation path.** The agent can rewrite what counts as passing, and CI is
  usually where a repository's secrets are. It bypasses code review and reaches
  credentials in the same move. This is not an argument against the decision —
  it is why the decision is written down instead of assumed.
- **Every Conversation reaches every repository in the Installation.** Anyone who
  can message roma has that reach. Which repositories the App is installed on is
  now the only control, and choosing that list is an operational decision with no
  code behind it.
- **An hour of exposure is the floor, not the ceiling.** The one-hour expiry
  bounds a *leaked* token. It does not bound the agent, which can mint another
  whenever it likes.
- **`npm start` now needs a GitHub App.** Running roma from source, locally, gets
  a private key as a prerequisite. There is no development mode that skips it,
  because required means required.
- **The refusal on an empty environment grows.** `scripts/verify-image.sh` and
  `src/packaging.test.ts` both assert on it. CI is unaffected: roma is never
  booted there.
- **`wiring.test.ts` needs a fake minter** — which is what the port is for.
- **Seven idle days can now lose unpushed work.** Accepted, and now said out loud
  in both CONTEXT.md and ADR-0006's neighbourhood rather than papered over.
- **Nothing here has been measured.** Every mechanism — the helper protocol, the
  hook firing under the agent's actual commit commands, the system prompt
  landing — is a documented behaviour that this repository has not observed. The
  house standard is measurement (ADR-0002, ADR-0003, the transcript collision
  work), and this ADR does not meet it yet.

  **Updated by #60**, and only partly. The helper protocol *is* measured now, and
  continuously: `src/github/git-credential-shim.test.ts` drives a real `git`
  against the real Shim in the default run, with no network and no credential, and
  asserts that the answer is accepted and that the request carries the repository
  path. Everything else on the list is still unobserved, including the two that
  decide whether large parts of this were worth building — whether `gh`
  authenticates with an Installation Token at all, and how many times `git` asks
  for a credential during a *successful* clone.

## Alternatives considered

**Bind a Conversation to a repository and down-scope the token to it.** The
recommended option, and rejected. It would have made the blast radius of a
Conversation one repository instead of an entire Installation, at the cost of one
Command, one small file per Conversation next to the `.generation` files, and a
checkout policy of roma's own. The file has a precedent that works; what it does
not have is the property that precedent claims for itself — a repository binding
would be *looked up*, and `session-generation.ts`'s "nothing is looked up here"
would stop being true of the directory. Declined in favour of the agent's own
freedom to clone.

**Bind one repository per deployment, by environment variable.** Rejected. A team
does not have one repository, and this only moves the blast radius from a
Conversation to a roma while looking like it shrank it.

**The token as an environment variable, or a static `.git-credentials`.**
Rejected on the one-hour expiry, which neither survives, and — for the
environment variable — on `env` writing it into a Transcript nothing ever
deletes.

**A local credential-injecting proxy.** The only option on the table that is
genuinely a boundary against the agent: the token would never exist inside the
container at all. Rejected for now as a great deal of new infrastructure ahead of
the egress allowlist, which ADR-0003 already names as the protection actually
doing the work and which still does not exist. If that is built, this belongs in
the same conversation.

**A full forge adapter under `src/forges/github/`, mirroring `src/channels/`.**
Rejected as symmetry for its own sake. The Channel abstraction exists because a
second Channel is the point of the product; a second forge is not on anybody's
list, and the testing seam is served by a narrow port.

**Treating GitHub as a second Channel and reusing the Channel denylist.**
Rejected: one invariant asked to mean two things stops explaining either.

**Read-only access.** Rejected as a fiction. Under `bypassPermissions` an agent
that can clone can push, and "we did not teach it to" is a wish rather than a
boundary. Real read-only is `contents: read` on the Installation and nothing
else — which was on the table and is not what was wanted.
