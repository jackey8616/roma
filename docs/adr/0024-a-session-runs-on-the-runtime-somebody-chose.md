# 24. A Session runs on the Runtime somebody chose

Date: 2026-08-04

## Status

Proposed — the decisions below came out of a design interview, not a build.
Nothing here has been measured in this repository yet; the verification agenda
is in ADR-0025, and every claim below about Codex's own behaviour is sourced
from its documentation and from a reference implementation rather than from a
capture roma holds. Where this ADR and a measurement later disagree, the
measurement wins and this file gets amended.

Replaces the design this pull request previously proposed — a second Runtime
reached through a provider prefix on `/model` — which is withdrawn rather than
amended, and the review of that draft is why. Its central finding was that the
crossing mechanism be replaced rather than softened, with the rule that a
Runtime is chosen when a Session is born; choosing it at birth by asking
removes the crossing altogether, and with it all five consequences the review
enumerated. The review's remaining findings are answered below and in
ADR-0025, each where it belongs.

A second review, of *this* design, followed. Three of its findings changed a
decision and are visible below: Codex is optional rather than a deployment
requirement, `/clear`'s changed contract is named where it happens instead of
being absorbed, and the offer's outer bound is the Transport's own number
rather than a promise roma is not in a position to make. The other two were
repairs to what this file and `CONTEXT.md` said, and are made where they were
wrong.

## The decision

roma gains a second Runtime: **Codex**, beside Claude Code. A Runtime is the
agent CLI serving one Session's Turns, and it is a property of the Session —
chosen by a person when the Session starts, fixed for the Session's life, and
asked again only where a new Session begins, which is what `/clear` makes.

**Codex is optional, and a deployment that has not configured it is not
changed by this ADR at all.** An earlier draft of this file made both Runtimes
deployment requirements, and the review of it is why that is withdrawn:
`CONTEXT.md` gives *required* to the Installation alone — "the one Reach no
deployment can boot without — required means required, which is the whole of
what makes it unlike the others" — and a second subscription, a seeded
`auth.json` and a new writable mount are not something one clause may quietly
make the price of booting a version somebody already runs. Claude Code stays
required. Codex is configured or it is not.

So the offer below is drawn **only where a deployment has both Runtimes**.
Where it has one, that Runtime is every Session's without anybody being asked,
nothing parks, and no card is posted. This is the grandfathering rule one
level up — the same refusal to make somebody answer a question that has only
one answer, applied to deployments rather than to Sessions — and it is what
keeps the `CARD_CLICKED` risk this ADR owns from becoming universal before it
has been proven: an unproven event path is crossed only by deployments that
opted into the second Runtime.

The shape repeats ADR-0014 and ADR-0016 for a third per-Session setting, and
the repetition is the point — the record is a file beside `.generation`,
`.model` and `.effort`, reclaim steps over it, and a missing one has a defined
meaning (see grandfathering below). What is **not** repeated is the default:
a Session with no Chosen Model runs on the Pinned Model, but there is no
"pinned Runtime" a Session falls back to. Where a deployment has both, a
Session's Runtime does not exist until somebody picks it and nothing runs
until somebody does; where it has one, there is nothing to fall back *from* —
every Session is on the only Runtime there is, and that is not a default
standing in for an answer nobody gave.

## What a new Session does not carry

Because the Runtime is fixed at birth, moving a Conversation onto the other one
is a `/clear` — and a `/clear` starts from nothing. That is the cost, and it is
stated here in its own section rather than left in a subordinate clause,
because a reader who knows this system well can still finish the decision
expecting the conversation to come along. It does not. The next Session does
not know what the last one was told.

Two ways of softening that were considered, and neither is taken.

A **summary handoff** — roma asking the outgoing Session for a précis and
opening the new one with it — is deferred rather than refused. It carries its
own decisions: who pays for the Turn that writes it, what a summary is allowed
to omit, and whether the person can read it before it is spent. None of them
are this ADR's.

**Translating the Transcript** into the other Runtime's format is refused
outright, and it is named here so that its absence does not read as
availability:

- An agentic Transcript is mostly tool traffic, and the two Runtimes' tool sets
  differ. Dropping that traffic loses what the agent actually did; mapping it
  asserts an equivalence nobody has measured — which is the one thing the
  Status section above forbids this ADR from claiming.
- It is not cheap. A Transcript measures 27,822 bytes per Turn plus 7,721
  one-off per Session (`docs/transcript-growth-verification.md`), so a
  twenty-Turn Conversation would arrive as a very large first Turn, paid on the
  window it has just moved onto.
- It requires roma to read the Transcript, which roma does not do. The line is
  drawn in the glossary — "reads nothing out of it" — decided in ADR-0006, and
  enforced in `src/session-pool.ts`, which takes the session id off what the
  CLI said and "never off the transcript's own path — that path is undocumented
  and Claude Code's to change". Codex's rollout files are the same kind of
  thing and inherit the same refusal.

## The offer

Everything in this section describes a deployment that has both Runtimes. One
that has a single Runtime draws no card and reads none of it.

The first message of a Conversation — and the first after every `/clear` — is
a real request, typed by somebody who wants it answered. So the choice is not
allowed to cost them the message:

- The Task **parks**. Parked is the Overflow machinery, reused deliberately:
  no concurrency slot, no process, stoppable throughout, and the Delivery
  stays unsettled so a restart replays the flow instead of losing the request.
- The Channel renders the offer. On Google Chat that is one card with two
  buttons — labelled CX and CC — and the click comes back the way the
  Overflow button's does.
- The click writes the record, wakes the parked Task, and the card is edited
  into the feedback: which Runtime, that the Session has started, and who
  chose. The original request then runs on the chosen Runtime with no retyping.
- **Anyone in the Conversation may click, and the first click wins.** A
  Conversation is many people sharing one Session and a Caller is a property
  of a message, never of a Session — restricting the click to the first
  sender would introduce exactly the Session-level person binding the domain
  model refuses. The Overflow button is already anybody's to press.
- **The offer does not expire.** An unanswered card is a visible stall, and
  anybody can resolve it at any moment — by clicking, or with `/clear`. A
  redelivery that finds the Session still waiting edits the standing card
  rather than posting a second one. The alternatives were a timeout that
  throws the held request away, and a default that spends one provider's
  money because nobody said anything; the first defeats the reason the Task
  parks at all, and the second is a decision roma does not make on anybody's
  behalf — the same argument that keeps Overflow opt-in per Task.
- **The request behind it does expire, and that is the Transport's to say.**
  The offer is roma's own state and outlasts anything; the held request is a
  Delivery, and a Delivery is Pub/Sub's. The lease lapses at
  `ROMA_PUBSUB_MAX_LEASE_MINUTES` — an hour by default — and the event comes
  back, which is the redelivery the bullet above edits the card for and the
  same path a Task Parked on a spent Shared Window already takes. Two outer
  bounds end that cycle: `dead_letter_max_delivery_attempts`, set to Pub/Sub's
  ceiling of 100 at roughly one attempt an hour, and
  `message_retention_duration` at seven days. Whichever arrives first, the
  request is dead-lettered or dropped while the card is still standing. roma
  does not pretend otherwise: a click on a card whose request is gone writes
  the record, says the Session has started and which Runtime it is on, and
  says plainly that the message it was holding is no longer held and wants
  sending again. Bounding the card to the Delivery instead was refused: it
  throws away the person's decision along with their message, and the decision
  is the half worth keeping.
- `/clear` posts the offer immediately, without waiting for the next message,
  and that **changes what `/clear` promises**: ADR-0013 gives the Conversation
  a fresh Session, and a fresh Session now serves nothing until somebody
  clicks. It is named here rather than absorbed, because `/clear` is the
  highest-traffic Command there is. What bounds the change is the rule above —
  a deployment that has not configured Codex sees `/clear` behave exactly as
  it does today — so the new contract is something a deployment took on with
  the second Runtime, not something this ADR does to everybody. The card it
  posts has no held request behind it, which is a state the design carries
  anyway because `/stop` can end a parked Task while its card stands: a click
  on such a card writes the record, says so, and waits for work.
- Messages arriving while the Session waits queue behind the choice: the Task
  Queue already serialises a Session's Tasks, and the first click releases
  them in order.

**Selection is button-only.** A typed selection (`cc` / `cx` as a whole
message, or a Command) was considered and declined. The consequence is
recorded rather than hidden: on a deployment with both Runtimes the one path
into a running Session now crosses `CARD_CLICKED`, which is the one event
shape in this repository that has never been proven against a real Workspace
— `chat-events.ts` says so of the Overflow button it was written for.
ADR-0025's verification agenda therefore
front-loads a real-Workspace capture of a card click before this ships, and
a card that has stood unanswered past a threshold is written to the Operator
Log, so a broken button reads as a broken button and not as silence. If that
verification fails, a typed selection is the repair, and this paragraph is
its justification.

## Commands and Relays under two Runtimes

`/stop` and `/clear` touch only what roma itself holds — work in flight, the
Session Generation — and behave identically on both Runtimes.

`/model` and `/effort` **set** nothing on a Codex Session in this version:
with an argument they refuse, naming the Runtime and its pinned model, and
bare they still report — the report is never Runtime-gated, on the principle
that "there is none" is a sentence roma says out loud (ADR-0015 §9). Codex
has no Model Menu and no Effort Menu yet; ADR-0025 records that the protocol
takes both per call, so this is scope deferred, not capability denied.

`/config` reports Runtime-aware: the Runtime, its model, and — where the
Runtime is Claude Code — the effort.

The five Relays are refused on a Codex Session, and structurally rather than
by policy: a Relay is a message handed to the Session's process **as
itself**, and the Codex wire has no such thing to hand it to — slash commands
are its interactive TUI's, and the app-server protocol's only free-text entry
is prose. The refusal sentence says the feature is Claude Code's.

While a Session awaits its Runtime, `/model`, `/effort` and `/config` with
arguments refuse and point at the standing offer: those settings belong to a
Session, and which Session this is has not been decided yet.

## Grandfathering

A Session spawned before this feature has no record, and no record on a
Session that has already been spawned means **Claude Code** — today's
behaviour, uninterrupted. No card ever appears mid-conversation; the choice
reaches existing Conversations at their next `/clear`, where a new Session
begins and the ordinary rule applies. Only a Session that has never been
spawned parks its first Task on the offer.

## The Audit Record

Every Audit Record gains the Runtime, Claude Code's included. A Chosen Model
is a Caller moving the shared bill and the Record is what remembers which
Task did (ADR-0014); a Runtime choice moves the bill **between providers**,
and the same argument puts it in the same place.

## Consequences

- The glossary generalises: Session, Transcript, Shared Window, Parked,
  Pinned Model and Pinned Effort all stop being sentences that could only
  ever mean one provider. Overflow does not generalise — it is Claude Code's
  for now, and its entry says so.
- Three further entries change **behaviour** rather than wording, and are
  amended with the rest rather than left to read as they did: **Command**,
  which says `/model` sets a Chosen Model and does not say that on a Codex
  Session it sets nothing; **Relay**, which names no Runtime at all where all
  five are now refused on one; and **Attempt**, whose "between one and three"
  counts a park and an Overflow that a Codex Task has neither of, so on that
  Runtime it is always exactly one.
- "A named list does not grow on its own" gains another instance: the pair of
  Runtimes is a closed list, and adding a third is a deliberate act somebody
  writes down.
- The mechanics of the Codex Runtime itself — process model, credential,
  pins, and the money asymmetries — are ADR-0025's.
