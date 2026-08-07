# 26. Codex is driven over app-server, and roma keeps its home

Date: 2026-08-04

## Status

Proposed — ADR-0025 decides that a second Runtime exists and how it is chosen;
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
say whose `high` it names, without a lookup table — is ADR-0025's Runtime
field carrying exactly that.

What the agenda lost in growing from three items to nine was the withdrawn
draft's other property: its questions were ordered by how much falls if the
answer is no, and it named the first as the load-bearing wall. Seven of the
nine then said nothing about a negative answer at all. That is restored below,
after the merge rather than in it, because it is what the sprint's tickets take
their order and their blocking edges from.

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

One new durable, **writable** mount is the entire Codex state: `CODEX_HOME` —
`auth.json` beside `sessions/`. It is what configuring Codex *means*: a
deployment that wants the second Runtime must have it, and a deployment that
does not needs nothing new and is not asked for anything (ADR-0025). Where
Codex is configured it is required exactly the way `ROMA_CLAUDE_CONFIG_DIR`
is, and for the same two reasons at once:

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
unchanged: it holds the three keys it already held — the App's private key and
the two service account keys, the Cloud Reach's and the Document Reach's — and
gains none here. A Runtime's subscription credential is not roma's to mint
from, on either side.

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
- **The Startup Self-Check.** Blocking on every Runtime the deployment
  configured: a real handshake and a probe Turn proving the credential
  resolves and the pinned model is what answers, before anything that could
  accept an Ingress Message is built. Claude Code's runs unconditionally, as
  it does today. Codex's runs where Codex is configured and is exactly as
  blocking there, because a Runtime roma is willing to offer is a Runtime roma
  has proved — an offer that can be clicked onto a broken credential is worse
  than no offer. A deployment without Codex boots precisely as it boots now.

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
one is a claim this repository currently holds on somebody else's word.

**Each item says what a negative answer costs**, because that is the half of a
verification agenda that decides anything: it fixes the order the sprint runs
in, and it says in advance whether a "no" is a repair these two ADRs have
already authorised or a decision somebody has to make again. The numbering is
the order the items were written in and is left alone — item 8 cites item 3 by
number and so does the review that asked for it. The order by how much falls is
**2, 3, 7, 1, 5, 6, 4, 8, 9**, and item 2 is the load-bearing wall: every one of
items 4 to 7 describes a resident process and none of them survives its answer
being no. Item 1 is the one place that order should not be read as a schedule —
it touches no Codex at all and can be captured against the Workspace roma
already has, so it runs first in wall-clock whatever its rank.

1. A real-Workspace capture of `CARD_CLICKED` arriving over Pub/Sub — the
   selection's only path (ADR-0025), and the Overflow button's overdue proof.
   A negative answer is the one this pair of ADRs has already answered:
   selection becomes typed, ADR-0025's *Selection is button-only* is amended
   into its own last sentence, and nothing else in either file moves. It also
   convicts a button that shipped — the Overflow offer has been crossing this
   event since ADR-0018 on nobody's proof — so a "no" here is a bug report
   against `main` before it is a design change.
2. `thread/resume` continues a thread across a process end, and across a roma
   restart. A negative answer takes *The process model* with it: the case for
   a resident app-server under the Session Pool **is** that resume exists, and
   without it the only remaining shape is exec-per-Turn, which this ADR rejects
   above for introducing a Session that is never Resident. So a "no" is not an
   amendment to this file but a decision made again from the top, and Eviction,
   Reaping and restart lose the account of themselves given here.
3. `thread/start` accepts `model` and `effort` on the pinned build, and what
   answers is the pinned model — the self-check's foundation. A negative answer
   splits. If the per-call parameters fail but the `config.toml` backstop holds,
   the pin survives and loses its second belt. If neither can make the pinned
   model the one that answers, *The pins* has no mechanism and the Startup
   Self-Check has nothing to probe for — and what goes with it is ADR-0003's
   sentence, that roma runs the model it insists on rather than the vendor's
   default, which this Runtime may not ship without. ADR-0025's Opening would
   be naming a model on somebody's word.
4. Thread id key tolerance (`id` vs `sessionId`), `<turn_aborted>` as a
   terminal marker, and the wedge watchdog's thresholds. A negative answer is
   a port that needs its own handling rather than a decision that needs
   remaking — the quirks are hermes's scars and roma's pin may not carry the
   same ones. The watchdog is the exception: if no threshold tells a wedged
   process from a slow Turn, **Retirement** has no trigger, and "the Session
   survives it by construction" is a claim with nothing behind it.
5. Token usage and the compaction flag on `turn/completed`, differenced the
   way Claude Code's cumulative totals are. A negative answer costs the Audit
   Record. Dollars are already conceded as unpriced; tokens are what is left,
   and a Codex Task that reports neither is unaccounted — which ADR-0014 and
   ADR-0018 both forbid, resting as they do on a Record that says what a Task
   spent. The compaction flag is ADR-0019's, and a Turn that compacts without
   saying so is that ADR's cost fact going missing.
6. The refresh race: concurrent resident processes against one `auth.json`,
   including one process refreshing while another starts. A negative answer
   falsifies nothing above; it adds mechanism this ADR does not design. *The
   home* leaves concurrency at "the reference implementation survives it", and
   a lost race on a single-use refresh token does not degrade — it invalidates
   the credential and takes the deployment's second Runtime down until an
   operator re-seeds the file by hand. The cost of a "no" is a serialisation
   roma has to build; the cost of not asking is an outage with no visible
   cause.
7. The permission profile lands from `config.toml` and the agent can write
   in its Working Directory and nowhere it should not. A negative answer is the
   only one on this list with no repair named anywhere: the per-thread
   `permissions` parameter is already rejected above on the reference
   implementation's live test, so if `config.toml` does not land either, roma
   has no way to set the posture and Codex runs at whatever its own default is
   — a security decision nobody made, arrived at by omission. This item blocks
   shipping rather than reshaping a section.
8. The pinned build's own reasoning-effort levels, read the way Claude Code's
   were: `scripts/claude-code-effort-matrix.ts` extracted them and a person
   reviewed the table before it became a constant. This Runtime's pinnable set
   comes out of that reading, and `ultracode` is not in it — that is a Claude
   Code alias for `xhigh` plus dynamic workflow orchestration, off the Effort
   Menu and reachable only through the operator, so accepting the word on a
   Codex Session would be a silent reinterpretation rather than a level. Rank
   this below item 3: a negative answer narrows what the pin may be set to and
   falsifies nothing else.
9. What a Conversation actually sees when a standing offer outlives the
   request behind it — the dead-letter or retention bound reached with the
   card still posted (ADR-0025). The numbers are `infra/`'s and already
   written down; what is unproven is the sentence at the end of them, and it
   is the one a person reads at the moment roma has lost their message. A
   negative answer falsifies that sentence rather than a decision: ADR-0025
   promises a click on a card whose request is gone says so plainly and asks
   for the message again, and this is where that promise is kept or found to
   be describing something else. It ranks last because least falls, not
   because least is read — the repair is wording, plus whatever handling the
   dead-letter path turns out to need.
