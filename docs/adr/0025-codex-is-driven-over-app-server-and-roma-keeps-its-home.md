# 25. Codex is driven over app-server, and roma keeps its home

Date: 2026-08-04

## Status

Proposed — ADR-0024 decides that a second Runtime exists and how it is chosen;
this one decides how roma drives it. Nothing below has been measured in this
repository yet. The facts about Codex come from its protocol documentation and
from hermes-agent, a working integration whose scars are documented in its
sources; the verification agenda at the end is the list of claims that must be
re-established against roma's own pinned build before any of this ships.
Where a measurement later disagrees, the measurement wins and this file gets
amended.

The spike that the design this pull request previously proposed gated
construction on survives here as that agenda, extended by one item the review
of that draft asked for: the pinned build's own reasoning-effort levels, which
nothing in it read. The review's requirement of a Pinned Effort per Runtime is
answered under The pins, and its recording requirement — that an Audit Record
say whose `high` it names, without a lookup table — is ADR-0024's Runtime
field carrying exactly that.

## The process model: app-server, resident

roma drives Codex over `codex app-server` — JSON-RPC 2.0 on stdio, an
`initialize` handshake, `thread/start` and `turn/start`, streamed `item/*`
notifications until `turn/completed` — as a **resident process owned by the
Session Pool**, exactly as a Claude Code process is.

The alternative was one `codex exec resume <id>` process per Turn, and it
lost on roma's own conventions rather than on taste:

- roma's Claude Code integration *is* "a resident process speaking the
  vendor's stream protocol, governed by the Pool". The app-server is that
  shape; exec-per-Turn would have introduced a Session that is never
  Resident, a new concept, to save a protocol integration.
- **`thread/resume` exists** — reopen an existing thread by id, subsequent
  turns append. That is what makes Eviction, Reaping and a restart work
  roma's way: the Pool records the thread id and resumes it, and nothing the
  person using the Session can observe changes. This is also where roma
  deliberately diverges from the reference implementation: hermes never
  resumes, because it keeps its own message history and can rebuild a thread
  from it. roma keeps no history by design — the memory is the Runtime's —
  so roma resumes.
- Interruption is a protocol method (`turn/interrupt`), the analog of the
  in-band interrupt ADR-0003 measured for Claude Code. exec-per-Turn's only
  stop is a signal, with unverified consequences for a rollout file cut off
  mid-write.
- `turn/completed` carries token usage and a compaction flag, which is what
  the Audit Record needs.

The costs, named: a JSON-RPC client, a wedge watchdog, and a protocol whose
documented quirks include thread ids serialised under two different keys
across versions and turns that end in a raw `<turn_aborted>` marker instead
of a completion event. hermes carries handling for all three; roma's port of
that handling is what the live tests below exist to prove. A wedged process —
CPU-spinning, auth-broken, or timed out — is **retired**: ended so the next
Turn respawns and resumes. Retirement is Eviction with a different prompt,
and the Session survives it by construction.

## The home

One new required, durable, **writable** mount is the entire Codex state:
`CODEX_HOME` — `auth.json` beside `sessions/`. It is required the way
`ROMA_CLAUDE_CONFIG_DIR` is, and for the same two reasons at once:

- `sessions/` holds the rollout files, which are **the Transcript of a Codex
  Session** — the only account there is of what the agent did. Everything
  ADR-0005 and ADR-0006 argue applies verbatim: durable, only grows, roma
  deletes nothing from it, and losing it is data loss the image must not be
  able to cause by defaulting the path.
- `auth.json` is the subscription credential, and it cannot be mounted
  read-only because the CLI rewrites it: a ChatGPT login refreshes through a
  **single-use** refresh token, so the file on disk is the credential's only
  valid copy and every refresh replaces it. Copying it elsewhere is the
  documented foot-gun — two copies race, the loser is invalidated, and the
  operator sees an auth failure that no setting explains.

The operator seeds `auth.json` once, per Codex's own CI guidance: log in on a
trusted machine, place the file in the mount, and let the CLI keep it fresh
from then on. roma builds no OAuth flow of its own — the convention is
`CLAUDE_CODE_OAUTH_TOKEN`'s: the operator obtains the Runtime's own
credential, and roma carries it without ever interpreting it. The Minter is
unchanged and still holds exactly two keys, GitHub's and the cloud's; a
Runtime's subscription credential is not roma's to mint from, on either side.

What roma does adopt from hermes is the **refresh-death classification**: a
refresh that fails terminally — a 4xx, an `invalid_grant`, a revoked grant —
is quarantined rather than replayed, written to the Operator Log as
"re-authentication needed", and fails the Task that hit it with a sentence a
person can act on. A dead credential must read as a dead credential, not as a
retry storm.

Concurrent resident processes share the one `auth.json`. The reference
implementation runs the same shape and survives it by retiring casualties;
whether roma needs more than that is a measurement, and it is on the agenda.

## The pins

Everything roma pins for Claude Code, it pins for Codex, because every
argument transfers:

- **The build.** The image carries a pinned Codex, the app-server protocol
  requires a floor in any case, and moving the pin is a re-verification
  event. ADR-0007's reasoning, second instance; the drift watch extends to
  the second pin.
- **The model.** `gpt-5.6-sol`, one per deployment, sent on every
  `thread/start` — the protocol takes `model` per call — with the roma-written
  `config.toml` in `CODEX_HOME` as the backstop. Not Codex's own default,
  which never runs: this is what roma insists on, ADR-0003's sentence
  verbatim.
- **The effort.** Pinned beside the model, because on this protocol `effort`
  is a first-class parameter on the same call — pinning it costs nothing and
  buys ADR-0016's property: it does not change what happens, it makes roma
  able to say what happens. The default is the pinned build's own default,
  measured at pin time; the env override is validated at startup as
  `ROMA_EFFORT` is.
- **The Startup Self-Check.** Both Runtimes, both blocking: a real handshake
  and a probe Turn proving the credential resolves and the pinned model is
  what answers, before anything that could accept an Ingress Message is
  built. Required means required, and it is now true twice.

## The money, version one

Deliberately asymmetric, and the asymmetry is recorded rather than smoothed
over:

- **No Parked-on-the-window for Codex.** A Codex Task that hits the
  provider's limit fails with a readable sentence, naming the reset where the
  error carries one. The park-and-wake machinery is built on Claude Code's
  window readings and Attempts; rebuilding it for a second provider is real
  work this version does not take on. The error classification that would
  feed it — exhaustion is distinguishable from transient throttling by the
  error's own shape — is adopted now, so the sentence is honest and the
  later park has its foundation. Reversal trigger: parked-versus-failed is
  the first asymmetry a Conversation actually feels; when the complaint
  arrives, this is the entry to reopen.
- **No Overflow for Codex.** Overflow's whole apparatus — offered per Task at
  the moment of blocking, a metered key, a monthly cap that is not roma's to
  default — is shaped around Claude Code's billing. A Codex metered path
  exists and is not taken; a deployment that wants it is asking for a second
  cap and a second offer flow, which is a decision to write down then, not a
  gap to fill quietly.
- The Audit Record prices a Codex Task in tokens, and its dollar cost is
  **unpriced** — the existing word for "spent, and nothing will ever name the
  amount" — because a subscription CLI reports no dollars. Unpriced, never
  free.

## The security posture, said plainly

roma runs Claude Code under `bypassPermissions`, and ADR-0003 names the
egress allowlist as the only protection still doing real work there. The
Codex face of the same decision is a full-access permission profile, written
by roma into `CODEX_HOME/config.toml` — via the config file rather than the
protocol's per-thread `permissions` parameter, because the reference
implementation live-tested that parameter as experimental-gated and rejected
without matching config. Same posture, same caveat, one more process it is
true of.

## Verification agenda

Every item below is a seam-2-shaped live test or a recorded verification
(`docs/*-verification.md`) that must exist before this ships, because every
one is a claim this repository currently holds on somebody else's word:

1. A real-Workspace capture of `CARD_CLICKED` arriving over Pub/Sub — the
   selection's only path (ADR-0024), and the Overflow button's overdue proof.
2. `thread/resume` continues a thread across a process end, and across a roma
   restart.
3. `thread/start` accepts `model` and `effort` on the pinned build, and what
   answers is the pinned model — the self-check's foundation.
4. Thread id key tolerance (`id` vs `sessionId`), `<turn_aborted>` as a
   terminal marker, and the wedge watchdog's thresholds.
5. Token usage and the compaction flag on `turn/completed`, differenced the
   way Claude Code's cumulative totals are.
6. The refresh race: concurrent resident processes against one `auth.json`,
   including one process refreshing while another starts.
7. The permission profile lands from `config.toml` and the agent can write
   in its Working Directory and nowhere it should not.
8. The pinned build's own reasoning-effort levels, read the way Claude Code's
   were: `scripts/claude-code-effort-matrix.ts` extracted them and a person
   reviewed the table before it became a constant. This Runtime's pinnable set
   comes out of that reading, and `ultracode` is not in it — that is a Claude
   Code alias for `xhigh` plus dynamic workflow orchestration, off the Effort
   Menu and reachable only through the operator, so accepting the word on a
   Codex Session would be a silent reinterpretation rather than a level. Rank
   this below item 3: a negative answer narrows what the pin may be set to and
   falsifies nothing else.
