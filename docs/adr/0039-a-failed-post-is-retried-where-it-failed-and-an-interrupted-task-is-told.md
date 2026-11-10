# 39. A failed post is retried where it failed, and an interrupted Task is told

Date: 2026-11-10

## Status

Accepted, and **implemented**. Closes #168, #171 and #172, the three outbound
failures ADR-0028 and ADR-0029 named and left open. Amends ADR-0028 at *A `redelivers`
flag on `Transport`*, which it reverses, and ADR-0029's consequence about a locked
thread, which it answers.

## Context

The three tickets are one question asked three ways: **what does roma do when it
cannot say something to a Conversation?**

- **#168.** A Chat post that failed had one remedy, the queue. `Ingress.take` logged
  `ingress-failed`, handed the Delivery back, Pub/Sub redelivered it, and roma ran
  the whole Turn again — minutes and real money — to repeat one HTTP POST. ADR-0028
  had already said the remedy belongs in `ChannelAdapter.deliver`, and the Discord
  Adapter had one; the Chat Adapter retried nothing.
- **#171.** `Serving.shutdown` hands every in-flight Delivery back so a deploy loses
  no Task. On a Transport that cannot redeliver — Discord's Gateway — the hand-back
  is a no-op, so every Task running when roma was signalled was lost, and the person
  was left watching an Acknowledgement that would never be edited again.
- **#172.** A Discord thread a moderator locks cannot be posted in, and a Conversation
  Key names that thread and nothing else. Every later outcome in it failed to deliver,
  and the failure surfaced only as an `ingress-failed` whose reason was a bare 403.

## Decision

### A Chat outcome is tried three times, with one request id

`GoogleChatAdapter.deliver` retries an outcome post up to `ATTEMPTS` (3) times. It
waits the `Retry-After` Chat sent where it sent one, and otherwise backs off from
`RETRY_FLOOR_MS` (1 s), doubling. A wait longer than `RETRY_CEILING_MS` (30 s) is given
up on rather than slept through. Enforced by `fence:gchat-outcome-retried-in-deliver`.
Enforced by `fence:gchat-attempts-bounded`.

What is worth repeating is a 429, a 5xx, or a call Chat never answered (a reset or
timed-out connection). Any other 4xx says the post itself is wrong and is thrown at
once. Enforced by `fence:gchat-refused-for-good-not-retried`. The binding reads
these off the HTTP client's error into a `ChatRefusal`, so the Adapter decides on a
status and never on a library's error shape — including the client's own `Headers`
class, which is not the global one. Enforced by `fence:gchat-retry-after-read-off-gaxios`.

**Every attempt at one post carries the same `requestId`.** Chat answers a request id
it has seen with the message it already made, so a post that landed but whose answer
was lost on the way back is not posted twice. This is what makes retrying a dropped
connection safe. Enforced by `fence:gchat-retry-posts-one-message`.

**A progress update is not retried.** The next update supersedes it, and ADR-0004
records Chat's quota for edits as *"Not yet specified"* — a retry would spend that
quota on text already out of date. This is where Chat's policy parts from Discord's,
which the ticket asked for rather than a copy. Enforced by
`fence:gchat-progress-not-retried`.

**The hand-back stays as the outer ring.** A post that has failed three times still
rejects, `serve.ts` still logs `ingress-failed` and nacks, and Pub/Sub still delivers
it again. Retrying in `deliver` repairs a blip; a Chat that is down for minutes is not
a blip, and redelivery is the only remedy that outlives it.

### A Transport says whether it redelivers, and shutdown branches on it

`Transport` gains `readonly redelivers: boolean` — `true` for Pub/Sub, `false` for
the Gateway. ADR-0028 rejected this flag because nothing would branch on it. Shutdown
now does:

1. Every Channel stops settling as done (unchanged).
2. **On each Channel whose Transport does not redeliver, the Core tells every Task it
   has not yet answered that it was interrupted** — a new `OutboundInstruction` kind,
   `interrupted`, which each Channel renders as *"roma was restarted before it could
   finish this task. Send it again once roma is back."* Queued and parked Tasks are
   told as well as running ones, and a message that arrives while the others are being
told is told the same rather than started. Enforced by
`fence:serve-shutdown-interrupts-late-arrivals`. Each one is logged as `task-interrupted`. Enforced by
   `fence:serve-shutdown-tells-what-it-cannot-hand-back`.
3. Transports close and the Resident Sessions end (unchanged).

The telling is bounded by `interruptWindowMs` (10 s by default); if a Channel cannot
be reached in that time, shutdown logs `ingress-interrupt-unfinished` and goes on,
rather than waiting until the platform kills roma outright. Enforced by
`fence:serve-interrupt-bounded`.

**`interrupted` is the last word on a Task that was told it.** When the killed Turn
then fails, the failure is not delivered: *"roma could not run this Task"* after
*"send it again"* contradicts the one thing the person can act on. A result that
finished inside the window is still delivered, since an answer is never worse than
none. Enforced by `fence:serve-interrupted-is-the-last-word`.

**A Transport that redelivers is not told anything.** The queue is holding the Task
for whatever starts next; *"send it again"* there asks for a second copy of a request
that will be answered anyway. Enforced by
`fence:serve-shutdown-silent-where-redelivered`.

### A locked thread is the operator's to hear about

Of #172's three outcomes, roma takes the second: **fail loudly to the operator**.
`DiscordRefusal` carries Discord's JSON error `code`, and when an outcome post is
refused with 160005 (*Thread is locked*) or 50083 (*Thread is archived*, which is
how a locked thread that has also archived answers), the Adapter logs
`conversation-locked` with the Conversation Key, the channel, the Task and the kind
of outcome, then rejects as before. Enforced by
`fence:discord-locked-thread-surfaces`.

Only outcomes are logged. An Acknowledgement that fails is followed by the outcome
that will fail the same way, so logging both says one thing twice per Task.

Falling back to the parent channel is rejected: a moderator locking a thread is a
person deciding the thread is over, and roma continuing it somewhere else overrides
that. Doing nothing is rejected because it is what #172 was filed against —
*"roma has stopped answering in this one thread"* is not a diagnosable symptom.

## Consequences

- **A Chat outage of a few seconds no longer costs a Turn.** One of minutes still
  does, by design.
- **A retried Chat post can be up to a minute late** — two waits, each 1–2 s of
  backoff or a Retry-After of at most 30 s — and a Task's Opening and anything queued
  behind it waits that long with it.
- **A Discord deploy no longer goes quiet.** Everybody with a Task in flight is told,
  and has to send it again — the Task is not resumed. That is the price of a Transport
  that cannot hold the request for the next roma.
- **A Pub/Sub deploy is unchanged**, including its documented cost: a Task that
  finished just as shutdown began is answered **and** run again.
- **A Task in a locked thread is still lost.** What changed is that the operator can
  see why, and the person can @-mention roma somewhere else to open a new Conversation.

## Alternatives considered

**Retrying progress updates on Chat as well.** Rejected; see above. The edit quota is
unknown and the update is stale by the time it would succeed.

**Stopping the nack on a delivery failure now that `deliver` retries.** Rejected; the
retry repairs blips, and the hand-back is still the only remedy for anything longer.

**Resuming interrupted Tasks on the next start.** It would need a durable record of
in-flight Tasks that roma does not keep, and ADR-0028 already rejected building that
durability under the Gateway. Telling the person is honest about what a socket can do.
