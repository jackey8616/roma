# roma

One central Claude Code agent a team reaches from any messaging channel. The name is from
"all roads lead to Rome" — Google Chat is the first road, not the destination.

`CONTEXT.md` holds the vocabulary; `docs/adr/` holds the decisions. Read ADR-0003 (the
channel-agnostic core) and ADR-0004 (Google Chat) before changing anything here.

## Requirements

- **Node 22** — `.nvmrc` pins it; `nvm use` picks it up.
- **Claude Code v2.1.220** on `PATH`, for the seam 2 tests. Behaviour is version-specific
  and every measurement in `docs/` is against that build — which is why the image pins the
  same version exactly, and why moving it is a re-verification event (ADR-0007).
- **Docker**, only to build or run the image.

```bash
npm install
```

## Commands

| command | does |
| --- | --- |
| `npm start` | Runs roma against Google Chat from the sources, via `tsx`. See below. |
| `npm test` | The default run. Fast, free, deterministic. |
| `npm run test:watch` | The same, watching. |
| `npm run typecheck` | `tsc --noEmit`, over `src` **and** `test`. |
| `npm run build` | `src` alone to `dist/`, which is what the image runs. |
| `npm run test:seam2` | **Spends money.** Drives a real `claude -p`. |
| `npm run check:claude-code-drift` | Is the pinned Claude Code still the published one? Reports; changes nothing. |
| `npm run check:claude-code-effort-matrix` | Which models does the pinned Claude Code strip the effort from? Reads it out of the binary and prints the gates it read, for a person to check `EFFORT_MATRIX` against. Nothing consumes the output and nothing fails on it (ADR-0016). |
| `npm run check:adr-collision` | Would merging this branch put two ADRs on one number? Reads the pull request's base branch, so it does nothing outside CI. |

### Seam 2 spends Shared Window quota

`npm run test:seam2` spawns real Claude Code processes and runs real Turns. It is opt-in,
it is slow, and every run draws on the same subscription window everybody else is using.

It lives in its own `vitest.seam2.config.ts`, so no invocation of the default config can
reach it. That is on purpose rather than tidiness: the alternative is a flag someone
forgets to pass.

It needs a Shared Window token — `CLAUDE_CODE_OAUTH_TOKEN` in a `.env` at the repo root
(get one with `claude setup-token`), or exported. Without it the run **fails** rather than
skipping: a silently skipped seam 2 reports green while the one contract the whole
architecture rests on goes unchecked.

## Running it

`npm start` is roma over Google Chat: it reads the environment, proves the credential with
the startup self-check, and only then subscribes. In development that runs the TypeScript
directly through `tsx`, from a normal `npm install`.

What ships is compiled. `npm run build` emits `src` alone to `dist/` — the tests are not
in it — and the image runs `node dist/channels/google-chat/main.js` under `npm ci
--omit=dev`, so `tsx` is a development dependency in fact and not only in the manifest.

### The image

```bash
docker run --rm \
  -e CLAUDE_CODE_OAUTH_TOKEN -e ROMA_PUBSUB_PROJECT_ID -e ROMA_PUBSUB_SUBSCRIPTION \
  -e ROMA_AUDIT_ROOT=/var/lib/roma/audit \
  -e ROMA_CLAUDE_CONFIG_DIR=/var/lib/roma/claude \
  -e ROMA_GITHUB_APP_ID -e ROMA_GITHUB_PRIVATE_KEY_FILE=/run/secrets/github-app.pem \
  -v roma-audit:/var/lib/roma/audit \
  -v roma-claude:/var/lib/roma/claude \
  -v /path/to/github-app.pem:/run/secrets/github-app.pem:ro \
  ghcr.io/jackey8616/roma:0.1.0
```

Add two more to give the agent a Cloud Reach — the identity it acts as in Google Cloud. Most
deployments have none and are unaffected; see `ROMA_CLOUD_KEY_FILE` below and
`infra/README.md` for how to create one and which project to put it in.

```bash
  -e ROMA_CLOUD_KEY_FILE=/run/secrets/cloud-reach.json \
  -v /path/to/cloud-reach.json:/run/secrets/cloud-reach.json:ro \
```

It carries **its own Claude Code, pinned to v2.1.220** — the version every measurement in
`docs/` was taken against. Moving that pin is a re-verification event that costs Shared
Window money, not a dependency bump, and nothing automated will ever move it for you.
ADR-0007 is why, and `src/packaging.test.ts` is what keeps it.

Something does say when it has fallen behind. `.github/workflows/claude-code-drift.yml`
compares the pin against what npm publishes, weekly, and files one issue when they differ —
naming both versions, what re-verification would cost, and every file that currently rests
on the pinned version. It opens no pull request and it edits nothing.

There is **no `latest` tag, and no `0.1` or `0`**. A tag that moves is a deployment whose
Claude Code changes underneath it, which is the whole thing the pin exists to prevent, so
`docker run` without a tag fails rather than guessing.

`ROMA_WORK_ROOT` is defaulted in the image, because losing it is by design — a week
untouched and it is reclaimed anyway. **`ROMA_AUDIT_ROOT` and `ROMA_CLAUDE_CONFIG_DIR` are
not**, because losing either is data loss and where they go is not the image's to decide —
run it with no volumes and it refuses to start, naming both. Mount something durable at
each: the Audit Records are the only place per-user attribution exists (ADR-0002), and the
Transcript is the only account there is of what an agent did (ADR-0005), which roma deletes
nothing from (ADR-0006).

roma runs as `node`, uid 1000. **Named volumes** at `/var/lib/roma/audit` and
`/var/lib/roma/claude` inherit that ownership, because the image makes both directories
even though it points nothing at either. A **bind mount** brings the host's own ownership
instead, so `chown 1000:1000` each host directory first — otherwise roma starts, clears the
refusal, and then loses the first Audit Record or the first Transcript to a permission
error, which is the same data gone by a longer route.

It also carries **`gh`, pinned to v2.96.0** by release tarball and hardcoded sha256. That
pin exists so that a rebuild cannot move it with nobody deciding to, and for no stronger
reason: unlike Claude Code's, moving it invalidates no measurement, so nothing watches it
for drift. The real binary is at `/usr/local/lib/roma/gh`, deliberately **off `PATH`** —
what answers to `gh` is roma's Credential Shim, which mints a token and hands it to the
one child process it starts.

It carries **no cloud CLI** — no `gcloud`, no `aws`, no `az`, and no second image tag to put
one in. Measured, and the measurement decided it: Google's CLI alone is 439 MiB unpacked
against a slim runtime, and it buys no capability, because roma *is* a Node program and Node
alone signs the credential and speaks HTTPS. What ships instead is `roma-cloud-token`, three
lines of shell in front of a module already in `dist/`: it prints an hour-long Cloud Token
on stdout, or `--json` for the token, its expiry and the account. ADR-0015 is why, and it
names its own reversal trigger — if writing the API calls by hand costs more in Turns than
439 MiB was worth in bytes, the CLI comes back.

That command is installed on **every** image, including the ones whose deployment has no
Cloud Reach, where it exits non-zero saying so. Omitting it would be `command not found`,
which a model reads as a broken `PATH` and spends a Turn investigating.

The image is `node:22-slim`, `linux/amd64`, non-root, with `git`, `gh`, `curl`,
`ca-certificates` and `tini` and nothing else. roma's agent runs arbitrary shell commands, so that list is a
decision rather than an accident — and `tini` is there because roma spawns `claude`
children, which a PID 1 that does not reap would leave as zombies.

### CI

Every pull request runs `typecheck`, `test`, `build` and a `docker build` that pushes
nothing. Pushing a tag equal to `package.json`'s `version` publishes that one image tag to
GHCR and no other; a tag that disagrees fails before anything is built.

A pull request also runs `check:adr-collision`, which is the only check here that reads a
commit other than this one. `src/adr-numbering.test.ts` asks whether *this tree* repeats an
ADR number; the number it cannot see is the one that is not in the tree yet, because two
branches can each add `0010-`, each pass alone, and the repeat then exists only in the
union — which is main, after both have merged. So this one builds that union first: base
and head together, less what either side deleted, which is what keeps a rename from reading
as a collision with the file it replaced.

**It narrows that window; it does not close it,** and its failure message says so rather
than letting the next person assume otherwise. It reads main as main is at the moment it
runs, so two pull requests open at once both pass and the first to merge makes the second's
green stale. Closing that needs GitHub's *require branches to be up to date before merging*,
which this repository deliberately does not set: it cannot be limited to the pull requests
that touch `docs/adr/` — that flag belongs to a ruleset's required status checks, and a
ruleset's conditions are branch names rather than paths — so it would cost every pull
request a rebase whenever main moved, against a fault that has happened twice across
fifteen ADRs and been caught by somebody reading both times. Making the check *block* a
merge rather than only go red is the same kind of setting: it has to be named in the
required checks, which is a repository setting and not in this repo's files.

One workflow is not a check. `claude-code-drift` runs weekly rather than on a commit,
compares the `Dockerfile`'s pin against the published Claude Code, and files a notify-only
issue when they differ. It ends red on an unreadable pin or a failed lookup, because a
drift check that passes while watching nothing reads as "the pin is current".

**Seam 2 never runs in CI** and no workflow is given a Shared Window token — roma is never
booted there. What the image is checked against instead is `claude --version` inside it, and
its refusal on an empty environment. `scripts/verify-image.sh` is both, and
`src/packaging.test.ts` fails if a workflow ever reaches for the money.

**roma provisions nothing.** The Pub/Sub topic, the subscription, the service account and
the grant that lets Chat publish all exist before roma starts; the variables below name
them. Creating them is not roma's job and it has no code that could —
`src/channels/google-chat/provisioning.test.ts` reads the sources and fails if it ever does.

Making them is `infra/`: Terraform somebody runs by hand, whose outputs are named for the
two required variables in the table below, so standing roma up is `terraform apply` and
then exporting what it printed. `infra/README.md` also carries the Chat-side steps
Terraform cannot do, in the order they have to happen.

### The environment

| variable | |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | **Required.** The Shared Window token everybody's Turns run on (`claude setup-token`). |
| `ROMA_WORK_ROOT` | **Required.** Where Sessions get their working directories. Reclaimed after a week untouched. |
| `ROMA_AUDIT_ROOT` | **Required.** Where Audit Records go, one file per calendar month. Deliberately not under `ROMA_WORK_ROOT`, which is reclaimed. |
| `ROMA_CLAUDE_CONFIG_DIR` | **Required**, and it decides two separate things. `CLAUDE_SECURESTORAGE_CONFIG_DIR` is what keeps a host keychain login out of a Claude Code process; `CLAUDE_CONFIG_DIR` is where that process writes the Transcript — the only account there is of what an agent did (ADR-0005). **Give it durable storage that only grows**: roma deletes nothing from here (ADR-0006), so unlike `ROMA_WORK_ROOT` it is never reclaimed. About **1 GB a year** at a hundred Tasks a day, plus 7.7 kB for every Session ever started (`/clear` starts another) — measured on the pinned build, two tool-using Turns on one Session (`docs/transcript-growth-verification.md`). One Task shape, so size the disk for the magnitude rather than the number (#41). |
| `ROMA_GITHUB_APP_ID` | **Required.** roma's GitHub App. There is no installation id to set: roma lists the App's installations and refuses to start if there is anything but one, naming all of them. |
| `ROMA_GITHUB_PRIVATE_KEY_FILE` | **Required.** A path to the App's private key, PEM. A path rather than the key inline, following `GOOGLE_APPLICATION_CREDENTIALS`: multi-line secrets belong in mounts. **Mount it read-only, and know what it is not:** roma is the only thing that reads it, but the agent runs in the same container under the same uid, so a shell can read it too. ADR-0008 claims otherwise and is wrong about that — `docs/github-app-verification.md` records the gap. |
| `ROMA_SHIM_DIR` | **Required**, and **defaulted in the image** to `/run/roma`. Where the Credential Shim socket and the gitconfig every Session runs under live. Holds nothing that outlives a boot, which is why it has a default at all — and it is deliberately not under `ROMA_WORK_ROOT`, whose weekly reclaim would take the socket with it. Set it when running from source; `/run` is not writable on a developer's machine. |
| `ROMA_PUBSUB_PROJECT_ID` | **Required.** The project the subscription lives in. |
| `ROMA_PUBSUB_SUBSCRIPTION` | **Required.** The subscription's name. Read, never created. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google's own, not roma's: a service account key file, or nothing at all on a Google host with a metadata server. This is the identity **roma** runs as — not the agent's. |
| `ROMA_CLOUD_KEY_FILE` | A path to a service account key file, and the whole of what gives the agent a **Cloud Reach**. Unset — the usual case — roma starts normally, announces nothing about the cloud, and `roma-cloud-token` says this deployment has none. Set, roma reads the key at boot **by exactly that path**, mints one token with it and throws it away, and refuses to start if any of that fails; it never falls back to another identity, because the fallback on a Google host is roma's own. The roles on that identity are the entire boundary — every Conversation reaches all of it, and so does everyone who can message roma. It must not be the identity above. `infra/README.md` has the steps and says which project to put it in. **Mount it read-only, and know what it is not:** roma is the only thing that reads it, but the agent shares the container and the uid, so a shell can read it too — the same gap `ROMA_GITHUB_PRIVATE_KEY_FILE` has. |
| `ROMA_OVERFLOW_API_KEY` | Metered billing. Absent, roma has no Overflow and never offers it. |
| `ROMA_OVERFLOW_MONTHLY_CAP_USD` | Required **whenever** the line above is set, and vice versa. There is no default: how much of your money roma may spend is not roma's to decide. |
| `ROMA_MODEL` | Overrides the pinned model. The self-check asserts on whatever this resolves to. |
| `ROMA_EFFORT` | Overrides the **Pinned Effort** — how hard the model is asked to think on every Session nobody has moved. `high` by default, which is what Claude Code itself falls back to, so setting nothing changes nothing and roma gains the ability to say what it runs at. Takes any level a Caller may choose (`low`, `medium`, `high`, `xhigh`, `max`) and also `ultracode`, which is off the Effort Menu and reachable only from here: it is `xhigh` plus dynamic workflow orchestration, which turns one Task into a fleet on a window everybody shares. **Validated at startup**, unlike everything Claude Code checks for itself — an unrecognised `--effort` only warns on stderr and starts on the default, so a typo here would otherwise be silent on every Session and every Audit Record. The self-check asks the probe process about it once and writes a disagreement to the operator log; the boot continues either way (ADR-0016). |
| `ROMA_MAX_CONCURRENT_TASKS` | Tasks that may run at once across every Session. Three by default. |
| `ROMA_GH_BIN` | Where the real `gh` is, for the Shim in front of it. `/usr/local/lib/roma/gh` by default, which is where the image puts it. Read by the Shim from **its own** environment, not from a Session's — `buildEnv` does not pass it through — so in practice this is for the tests and for anything invoking the Shim by hand. Running from source installs no Shim in front of `gh` at all, and the agent's `gh` is then whatever the developer has. |
| `ROMA_PUBSUB_MAX_MESSAGES` | Messages roma holds a lease on at once. Twenty by default — see `src/channels/google-chat/env-config.ts` for why it is not near the concurrency cap. |
| `ROMA_PUBSUB_MAX_LEASE_MINUTES` | How long a message may stay unsettled while its Task runs. An hour by default. |

Anything missing is reported in one refusal naming all of it, before anything is built.
Note that the metered key is **not** read from `ANTHROPIC_API_KEY`: that name is set on
developer machines for unrelated reasons, and reading it would turn metered billing on for
a whole deployment because a shell profile mentioned it.

### What running it against a real Workspace means today

There is a container now. There is still **no egress allowlist** — which ADR-0003 describes
as the only protection still doing real work under `bypassPermissions` — and no firewall.
A pullable image makes it *easier* to stand that agent up, not safer: an image reads like
"deployment is done" and it is not. An agent reachable from Chat by any Workspace member,
with unrestricted network access, is what you get until that protection exists.

## Where the Channel-specific code goes

Everything in `src/` is the Core, and none of it may name a Channel — not Google Chat,
not Pub/Sub, not any other. A Channel Adapter goes in `src/channels/<channel>/`, which is
the only place in `src/` that knowledge is allowed to exist — plus that Channel's own test
doubles under `test/support/`. `src/channels/google-chat/` is the first and so far the
only one.

Nearly all of roma's user-facing wording lives there too, because how a fact reads to a
person is the Channel's business. The exception is the sentence a failed Task carries: the
Core writes that one, since it says the same thing on every Channel, and the Adapter passes
it through unchanged.

`src/core.test.ts` enforces this by reading the sources, because "Google Chat is the first
road, not the destination" is a claim that would otherwise stop being true without anyone
noticing until a second Channel turned out to be a rewrite. It is a denylist of product
names over `src/`, minus `src/channels/` and minus the tests — so it catches a Channel
being *named* in the Core, not Channel knowledge that arrives without one.

## Where the tests are

Three seams, deliberately non-overlapping — see the Testing Decisions section of the spec,
which lives in this repo's GitHub issues (`gh issue view 1`).

- **Seam 1** — the Core, ingress in and outbound out. The default run. Claude Code is
  replaced by a fake that replays the recorded streams in
  `test/fixtures/claude-stream/`, so the events are real but free. `src/serve.test.ts`
  is the same seam at roma's outermost edge: an event arrives on a Transport a test
  drives by hand, and what comes out is a Channel that was told something and a delivery
  that was finished with or handed back.
- **Seam 2** — `ClaudeSession` and `SessionPool` against a real `claude -p`.
  `*.live.test.ts`.
- **Seam 3** — `GoogleChatAdapter` in isolation: a Chat event in and an ingress message
  out, an outbound instruction in and a recorded Chat API call out. No Workspace, no
  credential, no quota. Its Chat events are written from Google's documented shape rather
  than captured, which the test file says out loud — nothing here can capture one. The
  same goes for `HttpChatApi`, whose tests assert on the request Google would have
  received, and for `PubSubTransport`, whose subscription is a double.

`test/support/live-claude.test.ts` belongs to none of them. It is the default run
asserting something about seam 2's *scaffolding* — that the directories handed to a live
Session sit outside the checkout, so the Session inherits neither roma's `CLAUDE.md` nor
its project skills. It lives in the free run because seam 2 cannot catch that class of
bug: the contamination it guards against made those tests pass, expensively (#101).

`src/channels/google-chat/wiring.test.ts` is the one place the seams meet: roma assembled
out of its real parts, with only Claude Code and the network replaced. A Pub/Sub message
goes in and the request Google would have received comes out. It exists because every other
test proves one component in isolation, and the failure they cannot see is the one at the
joins — a Transport emitting events the Adapter cannot read gives you a roma that runs
perfectly and answers nobody.

Two things have no seam and cannot have one until roma runs against a real Workspace:
Google's auth library resolving a credential, and the fields a real Chat interaction event
actually carries. Both live behind a port — `SendChatRequest` and `PubSubSubscription` —
so what is untested is the edge rather than anything that decides something.
