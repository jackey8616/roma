# roma

One central Claude Code agent a team reaches from any messaging channel. The name is from
"all roads lead to Rome" — Google Chat is the first road, not the destination.

`CONTEXT.md` holds the vocabulary; `docs/adr/` holds the decisions. Read ADR-0003 (the
channel-agnostic core) and ADR-0004 (Google Chat) before changing anything here.

## Requirements

- **Node 22** — `.nvmrc` pins it; `nvm use` picks it up.
- **Claude Code v2.1.220** on `PATH`, for the seam 2 tests. Behaviour is version-specific
  and every measurement in `docs/` is against that build — which is why the image pins the
  same version exactly, and why moving it is a re-verification event (ADR-0006).
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
  -v roma-audit:/var/lib/roma/audit \
  ghcr.io/jackey8616/roma:0.1.0
```

It carries **its own Claude Code, pinned to v2.1.220** — the version every measurement in
`docs/` was taken against. Moving that pin is a re-verification event that costs Shared
Window money, not a dependency bump, and nothing automated will ever move it for you.
ADR-0006 is why, and `src/packaging.test.ts` is what keeps it.

There is **no `latest` tag, and no `0.1` or `0`**. A tag that moves is a deployment whose
Claude Code changes underneath it, which is the whole thing the pin exists to prevent, so
`docker run` without a tag fails rather than guessing.

`ROMA_WORK_ROOT` and `ROMA_CLAUDE_CONFIG_DIR` are defaulted in the image, because losing
either is by design. **`ROMA_AUDIT_ROOT` is not**, because losing that one is data loss and
where it goes is not the image's to decide — run it with no volume and it refuses to start,
naming it. Mount something durable there.

roma runs as `node`, uid 1000. A **named volume** at `/var/lib/roma/audit` inherits that
ownership, because the image makes the directory even though it points nothing at it. A
**bind mount** brings the host's own ownership instead, so `chown 1000:1000` the host
directory first — otherwise roma starts, clears the refusal, and then loses the first Audit
Record to a permission error, which is the same data gone by a longer route.

The image is `node:22-slim`, `linux/amd64`, non-root, with `git`, `ca-certificates` and
`tini` and nothing else. roma's agent runs arbitrary shell commands, so that list is a
decision rather than an accident — and `tini` is there because roma spawns `claude`
children, which a PID 1 that does not reap would leave as zombies.

### CI

Every pull request runs `typecheck`, `test`, `build` and a `docker build` that pushes
nothing. Pushing a tag equal to `package.json`'s `version` publishes that one image tag to
GHCR and no other; a tag that disagrees fails before anything is built.

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
| `ROMA_CLAUDE_CONFIG_DIR` | **Required**, and it decides two separate things. `CLAUDE_SECURESTORAGE_CONFIG_DIR` is what keeps a host keychain login out of a Claude Code process; `CLAUDE_CONFIG_DIR` is where that process writes the Transcript — the only account there is of what an agent did (ADR-0005). **Give it durable storage that only grows**: roma deletes nothing from here (ADR-0006), so unlike `ROMA_WORK_ROOT` it is never reclaimed. Roughly 4 GB a year at a hundred Tasks a day. |
| `ROMA_PUBSUB_PROJECT_ID` | **Required.** The project the subscription lives in. |
| `ROMA_PUBSUB_SUBSCRIPTION` | **Required.** The subscription's name. Read, never created. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google's own, not roma's: a service account key file, or nothing at all on a Google host with a metadata server. |
| `ROMA_OVERFLOW_API_KEY` | Metered billing. Absent, roma has no Overflow and never offers it. |
| `ROMA_OVERFLOW_MONTHLY_CAP_USD` | Required **whenever** the line above is set, and vice versa. There is no default: how much of your money roma may spend is not roma's to decide. |
| `ROMA_MODEL` | Overrides the pinned model. The self-check asserts on whatever this resolves to. |
| `ROMA_MAX_CONCURRENT_TASKS` | Tasks that may run at once across every Session. Three by default. |
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
