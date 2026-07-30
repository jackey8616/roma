# 7. A container image pinned to one Claude Code

Date: 2026-07-29

## Status

Accepted. Closes the "container image build and update process" item ADR-0003
left as follow-on work, and reverses what `README.md` said about there being no
build step.

**Renumbered from 0006 to 0007, 2026-07-29.** This was published 41 minutes after
ADR-0006 and took the same number, so for as long as both existed no citation
could say which one it meant.

**Amended 2026-07-29**, in the way ADR-0002 and ADR-0003 were — amendments are
marked inline — but not for the reason they were. Theirs corrected the evidence
beneath a decision that stood. This one corrects a decision: the storage table
below recorded `ROMA_CLAUDE_CONFIG_DIR` as "per-container by design", which is
the opposite of what ADR-0006 had decided three quarters of an hour earlier.

That is stated rather than tidied away, because the mechanism matters more than
the mistake. For the length of the overlap this repository held two contradictory
positions at once, both accepted, both live: the image treated the Transcript's
home as disposable while `README.md` told the operator to give it durable storage
that only grows. Nothing surfaced the conflict, and nothing could have — a
reference reading "ADR-0006" resolved to either document, so the two positions had
nowhere to meet. It was found by reading #41, not by any check. `src/adr-numbering.test.ts`
now fails on a repeated number, which is the narrow thing that was actually
missing.

**Amended again 2026-07-30**, to the accepted risks rather than to the decision.
"Nothing watches for Claude Code going stale" stopped being true when #52 landed
`.github/workflows/claude-code-drift.yml`; the bullet is struck through with what
replaced it, and nothing above it changes — the check reports the pin has fallen
behind and refuses to move it, which is this ADR's position rather than a
softening of it.

The row was never argued. The other two rows carry a paragraph of reasoning each;
this one carried four words and an inherited assumption. What is corrected below
is therefore an oversight rather than an overturned decision, which is why this is
an amendment and not a superseding ADR — the trade-off was made in ADR-0006 and is
not reopened here.

## Context

The container is not a new decision. ADR-0003 already fixed the runtime as *"a
long-running GCE VM running Docker, not Cloud Run"*, and its accepted risks
already lean on it — *"the container prevents exfiltration of personal
credentials"*. What has never been written down is how that image is built, what
is inside it, and what happens when the thing inside it moves.

Two facts make the last of those the whole decision:

- **`src/claude-session.ts` spawns the bare command `claude`, resolved from
  `PATH`.** An image without Claude Code in it cannot run roma at all, so the
  image carries one — and once it does, the image *is* a Claude Code version.
- **Every measurement in this repository is evidence about v2.1.220 and nothing
  else.** ADR-0003 says so, and asks for re-verification before the pinned
  version moves. Six documents rest on captures taken against that build.

Alongside it, the CI this repository has never had. It matters here more than it
would elsewhere, because the check that would catch a Claude Code change —
seam 2 — is the one check that cannot run in CI: it needs a Shared Window token
in a public repository's secrets and it spends real money on every run.

`README.md` stated the opposite position, and gave a reason:

> There is no build step — `tsx` runs the TypeScript directly, from a normal
> `npm install`. How roma is packaged and shipped is a deployment question, and
> deployment is out of scope for the spec […]

Deployment is in scope now, so the reason has expired rather than been overruled.

## Decision

### The image carries its own Claude Code, pinned exactly

`npm install --global @anthropic-ai/claude-code@2.1.220`. Exact, not a range and
not a dist-tag, and this is the decision everything else hangs off.

`@latest` would move it on every rebuild with nobody deciding to, and CI would
stay green while it happened. That is not a hypothetical gap in the checks; it is
the specific shape of this repository's checks. The consequence is worth stating
in its own right, because it is what ADR-0003 is for: **upgrading Claude Code
here is a re-verification event, not a dependency bump.** It costs Shared Window
money and it needs a human to read the diff in behaviour.

The number exists twice — the Dockerfile's `ARG`, and a literal in
`src/packaging.test.ts`. Deliberately: editing one alone turns the free run red,
and the test file is where the reason is written down.

### No moving image tags

Pushing tag `0.1.0` publishes exactly one image tag, `0.1.0`. No `latest`, no
`0.1`, no `0`.

`ghcr.io/…/roma:0` reads like a pin and is not one. A deployment that pulls it
after a later release gets a different Claude Code than the one its evidence was
gathered against — the same drift `@latest` was rejected for, walking back in
through the registry. `latest` is at least honest about being unpinned, but for a
system whose behaviour is version-specific, `docker run` without a tag should
fail rather than guess.

A tag whose name does not equal `package.json`'s `version` fails the release
before anything is built, because an image published under a registry tag that
contradicts its own `org.opencontainers.image.version` cannot be taken back off
GHCR afterwards.

### The image declares the one path whose loss is by design, and stays silent on the two that are data

| Variable | Image default | Why |
| --- | --- | --- |
| `ROMA_WORK_ROOT` | `/var/lib/roma/work` | Reclaimed weekly by design; losing it is expected |
| `ROMA_CLAUDE_CONFIG_DIR` | **none** | Losing it is data loss, and where it goes is not the image's to decide |
| `ROMA_AUDIT_ROOT` | **none** | Losing it is data loss, and where it goes is not the image's to decide |

**Amended — the middle row said `/var/lib/roma/claude`, "per-container by design",
and that was wrong.** The two rows either side of it were argued; this one was
not. ADR-0006 had decided forty-one minutes earlier that the Transcript is the
only account there is of what an agent did and that roma deletes nothing from it,
and `README.md`'s environment table already told the operator to give the
directory durable storage that only grows. The image contradicted both, in a
default nobody had to type — so the documented `docker run`, which mounted one
volume, put the Transcript in the container's writable layer and discarded it on
every replacement. roma was doing the deleting after all, on a schedule nobody
chose, by a route the decision not to delete never looked down. #54 took the
default out and gave the documented run a second volume.

The paragraph below is the argument that already existed for the audit root. It
is true of the Transcript word for word, which is the point: nothing new had to be
reasoned out, only applied to a third row.

`readRomaEnv` refuses to start without an audit root *deliberately* — "a missing
audit root is refused rather than put somewhere under the working directories,
which a weekly reclaim would delete". A Dockerfile that helpfully defaulted it
would re-open exactly that hole from a new direction: unmounted, the records land
in the container's writable layer and vanish with the container. ADR-0002 is
explicit that per-user attribution does not exist at the provider, so the Audit
Records are the only place it ever exists.

So `docker run` with no volumes is refused, naming `ROMA_AUDIT_ROOT` and
`ROMA_CLAUDE_CONFIG_DIR` — which makes the operator answer two questions the image
genuinely cannot.

The image does make and own `/var/lib/roma/audit` and `/var/lib/roma/claude`,
which is a different act from pointing at either. Docker materialises an empty
named volume mounted over a path the image never created as `root:root`, and roma
runs as `node`; without the directory, mounting a volume would clear the refusal
and then lose the first Audit Record, or the first Transcript, to a permission
error — the same data gone by a longer route, and gone at the point where the
refusal has stopped protecting anything. A bind mount carries the host's
ownership regardless, so the README says to `chown` both.

### The image is verified against two questions, and roma is not booted in CI

roma cannot be started in CI. `startGoogleChatRoma` needs a Shared Window token,
then Google credentials, then a real subscription, and only then runs a startup
self-check that drives a paid `claude -p` Turn. Proving the image boots would
mean two production credentials in a public repository's Actions secrets and real
money on every release.

Two checks that cost nothing get most of the way there, and
`scripts/verify-image.sh` is both of them, run by the pull-request build and the
release from the same file so the release cannot drift into checking less:

1. **`claude --version` inside the image equals the version the image declares.**
   The only check that catches the install layer breaking or the pin drifting.
2. **The entrypoint, on an empty environment, exits 1 and prints roma's own
   refusal**, with `ROMA_AUDIT_ROOT` and `ROMA_CLAUDE_CONFIG_DIR` among the
   problems named.

The second proves more than it looks: node runs, `dist/` is complete, ESM
resolution works, both runtime dependencies import — they are top-level static
imports, so they load before `main()` — and the `CMD` path is right.

**Asserted on the message, not only the exit code.** `node` exits 1 for a missing
module too, so an image with a broken `dist/` or a missing dependency passes an
exit-code-only check perfectly.

Neither of those two can ask whether the pin is the *right* version — an image
whose pin was moved declares and contains the same wrong number, consistently. The
literal lives in `src/packaging.test.ts`, so the release runs the suite as well:
a tag can be pushed at any commit, including one no pull request ever checked.

### `docker build` runs on pull requests, and pushes nothing

A Dockerfile only exercised at tag time breaks at the most expensive moment —
after the release has been decided — and usually because of a change merged weeks
earlier. Building without pushing is also the only shape a fork's pull request can
run at all, so contributors and maintainers take the same path.

`linux/amd64` only. The runtime ADR-0003 names is a GCE VM, and an unverified
architecture is an artifact with no evidence behind it.

The checks run as one job of three steps — `typecheck`, `test`, `build` — rather
than three jobs, because all three want the same `npm ci` and the suite runs in
under three seconds. `typecheck` and `build` are not redundant: `build` compiles
`src` alone and would not typecheck the tests.

### The agent's userland is deliberately small

`git` and `ca-certificates`, plus an init to reap the `claude` processes roma
spawns, and nothing else. roma's agent runs arbitrary shell commands, so the
image is a workspace and not only a runtime — but guessing at which tools it will
want produces an image nobody can explain, every line of it attack surface on a
public registry. Widening it is a separate decision with its own evidence.

It runs as a non-root user, on `node:22-slim`.

## Consequences

**Accepted risks:**

- **This is not the egress allowlist.** ADR-0003 describes that as "the only
  protection still doing work" under `bypassPermissions`, and it still does not
  exist. A pullable image that starts with one command makes it *easier* to run
  an agent with unrestricted network access, not harder. A published image reads
  like "deployment is done"; it is not.
- **Nothing here narrows ADR-0003's other accepted risk.** Any member of any
  connected channel can still direct Claude Code to do anything inside the
  container.
- **~~Nothing watches for Claude Code going stale.~~** The pin will fall behind and
  nothing will say so. Accepted here rather than overlooked: an automated bump
  pull request would look like routine maintenance while silently invalidating six
  documents' worth of evidence, and CI would pass. `.github/dependabot.yml` is
  therefore the base image and the actions only. A notify-only drift check is
  worth its own ticket.

  **Amended 2026-07-30 — something watches now (#52), and the decision above is
  unchanged by it.** `.github/workflows/claude-code-drift.yml` compares the `ARG`
  against the `latest` dist-tag of `@anthropic-ai/claude-code` weekly and, when
  they differ, files a single issue naming both versions, saying that moving the
  pin means re-running seam 2 against the Shared Window, and listing every file in
  the working tree that names the pinned version — generated with `grep`, so the
  size of the re-verification is legible rather than guessed.

  It is notify-only in the strict sense: it never edits the pin and it opens no
  pull request, for the reason the bullet already gives. It reads the pin out of
  the `Dockerfile` rather than carrying a third copy of the number, and an
  unresolvable pin, an unparseable `ARG`, a missing `Dockerfile` or a failed
  registry lookup ends the run **red** — only a successful comparison is allowed
  to be quiet. A drift check that swallowed its own failures would pass forever
  while watching nothing, and a green tick reads as "the pin is current".

  **This makes upgrading visible, not safe.** The re-verification this ADR asks
  for is still a human spending Shared Window money and reading a behavioural
  diff. What is gone is the part where nobody knew there was a decision to make.

  Two things it deliberately does not do. It has no opinion about *whether* to
  move, and it has no memory: an open report is edited in place, but a closed one
  is not remembered, so a version that is still what npm publishes is reported
  again next week. That is #52's own answer to the tedium — the cadence is the
  thing to change, not the check's willingness to keep saying so — and the
  alternative leaves a live drift with nothing announcing it, green and unwatched.

  One thing it cannot do: GitHub disables a `schedule` trigger in a repository with
  no activity for 60 days, so the check can stop watching without saying so.
  `workflow_dispatch` is the manual way to ask, and the reason it is there. Nothing
  watches the watcher.
- **The release workflow cannot be tested before it is merged.** It fires on
  tags, and tags come after merge. The first `0.1.0` is its first real run; if it
  fails, fix it and tag again.
- **GHCR package visibility is not the repository's.** After the first push the
  package is private until somebody changes it by hand, and no workflow can do
  that step.
- **Nothing in CI has ever run roma.** The two checks above are what stands in for
  it, and they cannot see a failure that needs a credential to reach — the
  self-check, auth resolution, the subscription. The first real boot of any image
  is on the VM.

**Also true now:** `npm run build` exists and `npm ci --omit=dev` is supported, so
`tsx` is a development dependency in fact and not only in the manifest.
`tsconfig.build.json` is a second config rather than a flag on the first, because
`tsconfig.json` includes `test` on purpose and a naive emit from it would compile
roma's test doubles into `dist/`.

## Alternatives considered

**`@latest`, or a caret range, for Claude Code.** Rejected — see the first
decision. The whole of this ADR is downstream of it.

**Publish `latest` alongside the version tag.** Rejected. It is the tag a reader
copies out of a README and the tag a `docker run` falls back to, and either way it
lands a deployment on a Claude Code nobody chose. `0.1` and `0` are worse, because
they *look* pinned.

**Default `ROMA_AUDIT_ROOT` or `ROMA_CLAUDE_CONFIG_DIR` to a path under
`/var/lib/roma`.** Rejected. It makes `docker run` with no arguments appear to
work, which is exactly the situation in which the Audit Records, or the
Transcript, are being written to a layer that will be discarded. The refusal is
the feature. *(The second name is what the amendment above adds. The image did
default it, and #54 took the default out.)*

**`VOLUME /var/lib/roma/claude` instead of the refusal.** Rejected. It declares
an *anonymous* volume, and `docker run --rm` — which is what `README.md`'s
example uses — removes anonymous volumes on exit. It would read as protection in
the Dockerfile and lose the Transcript anyway, which is worse than no protection:
the operator stops looking.

**Boot roma in CI to prove the image works.** Rejected. It needs a Shared Window
token and Google credentials in a public repository's secrets, and the startup
self-check spends money on every run. `src/packaging.test.ts` fails if any
workflow ever names a seam 2 test or is handed the token one would need, so this
stays rejected rather than drifting back in as a "smoke test".

**A single-stage image, running `tsx` over the sources.** Rejected. It ships the
whole toolchain, the tests and the fixtures to a public registry, and makes the
thing that runs in production a different execution path from the thing built and
checked. Compiling is also the check: `tsc` emitting is a stronger statement about
`dist/` than `tsx` starting is about anything.

**`linux/arm64` as well.** Rejected for now. Free native runners exist, but
nothing deploys there — see Not in scope in the ticket.

**Digest-pinning `node:22-slim`.** Not done. The reason the Claude Code pin is
exact does not transfer: no measurement in this repository is evidence about a
particular Debian build, and a digest pin with Dependabot behind it is a weekly
pull request that nobody can evaluate. Revisit if the base image ever becomes
load-bearing for behaviour rather than for having a libc.
