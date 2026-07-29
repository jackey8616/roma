# roma

One central Claude Code agent a team reaches from any messaging channel. The name is from
"all roads lead to Rome" — Google Chat is the first road, not the destination.

`CONTEXT.md` holds the vocabulary; `docs/adr/` holds the decisions. Read ADR-0003 (the
channel-agnostic core) and ADR-0004 (Google Chat) before changing anything here.

## Requirements

- **Node 22** — `.nvmrc` pins it; `nvm use` picks it up.
- **Claude Code v2.1.220** on `PATH`, for the seam 2 tests only. Behaviour is
  version-specific and every measurement in `docs/` is against that build.

```bash
npm install
```

## Commands

| command | does |
| --- | --- |
| `npm test` | The default run. Fast, free, deterministic. |
| `npm run test:watch` | The same, watching. |
| `npm run typecheck` | `tsc --noEmit`. |
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
  `test/fixtures/claude-stream/`, so the events are real but free.
- **Seam 2** — `ClaudeSession` and `SessionPool` against a real `claude -p`.
  `*.live.test.ts`.
- **Seam 3** — `GoogleChatAdapter` in isolation: a Chat event in and an ingress message
  out, an outbound instruction in and a recorded Chat API call out. No Workspace, no
  credential, no quota. Its Chat events are written from Google's documented shape rather
  than captured, which the test file says out loud — nothing here can capture one.
