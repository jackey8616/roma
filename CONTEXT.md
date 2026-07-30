# roma

roma is one central Claude Code agent that a team reaches from any messaging
channel. The name is from "all roads lead to Rome" — Google Chat is the first
road, not the destination.

## Language

### Reaching roma

**Channel**:
A messaging product a team member talks to roma through. Google Chat is the
first.
_Avoid_: platform, integration, client, transport

**Transport**:
The wire the ingress queue runs on. Distinct from a Channel: Pub/Sub is the
transport, Google Chat is the Channel, and more than one Channel can share a
transport.
_Avoid_: using this word for a Channel

**Delivery**:
One event handed over by the Transport, together with the means to say roma is
finished with it. It carries the Transport's own id for that event — the same on
every redelivery, because a queue that promises to lose nothing delivers some
things twice.
_Avoid_: message (that is the Channel's word and an Ingress Message's),
event (that is what a Delivery carries, not what it is)

**Settling**:
Saying roma is finished with a Delivery, one of two ways: it is done with, or it
is handed back to be delivered again. Deliberately **not** called acknowledging,
though one of the two is a Pub/Sub `ack` — an Acknowledgement is the message roma
posts into a Conversation, and the two words in one paragraph would be
indistinguishable. What is settled is the Delivery; what is acknowledged is the
person.
_Avoid_: acknowledging (see above), committing, completing

**Channel Adapter**:
The per-Channel component that translates that Channel's events into ingress
messages and roma's output back into Channel messages. The only place
Channel-specific knowledge lives.
_Avoid_: connector, integration, plugin, bridge

**Conversation**:
The user-visible exchange on a Channel — a Chat thread, a DM. One Conversation
maps to one Session.
_Avoid_: chat, thread (thread is a Google Chat term, not a roma one)

**Conversation Key**:
The stable string an Adapter supplies to name one Conversation. The Session id
is derived from it — and from the Session Generation, which is the only thing
`/new` can move — which is why roma needs no database.
_Avoid_: thread id, chat id, room id

**Ingress Message**:
What an Adapter hands the Core: a Conversation Key, a caller identity, and the
text. Everything else the Channel knew is gone by this point.
_Avoid_: event, payload, request

**Outbound Instruction**:
What the Core hands back to an Adapter — the result of a Task, why there isn't
one, or what the Task is doing meanwhile. It says what happened, never how it
should look.
_Avoid_: response, reply, command (a command is `/new` or `/stop`)

**Acknowledgement**:
The one message roma posts as soon as a Task arrives and then keeps editing
while it runs — that it is waiting, that a tool is running, the answer as it is
written. One per Task, throttled, and never the final result: that is always a
separate message. Where a Channel cannot edit, the acknowledgement is posted
once and nothing follows it.
_Avoid_: status message, progress bar, typing indicator

### Running work

**Core**:
The Channel-independent part of roma — the ingress queue through to the Claude
Code processes. Knows nothing about which Channel a message came from.
_Avoid_: backend, server, bridge, engine

**Session**:
The Claude Code state backing one Conversation: a Transcript, a session id, and a
working directory.
_Avoid_: context, history, conversation

**Transcript**:
Claude Code's own record of a Session, holding every event of every Turn it has
served. Not roma's: roma names the directory it lives in, reads nothing out of
it, deletes nothing from it, and writes no second copy — so this is the only
account there is of what an agent actually did. It therefore outlives the
Session's working directory, which ADR-0003 reclaims after seven idle days —
deliberately, and ADR-0006 is where that asymmetry was decided rather than
inherited.
_Avoid_: history, session file, event log, and the bare word "log" (that reads
as the Operator Log, which is roma's and says something else entirely)

**Working Directory**:
Where a Session does its work. roma's, unlike the Transcript: roma makes it and
ADR-0003 reclaims it after seven idle days. It is named here because it is the
Transcript's opposite number and the two are easily mistaken for one kind of
thing — they sit side by side and have opposite lifetimes, because losing this
one costs a checkout and losing the other destroys the only account there is of
what an agent did.
_Avoid_: workspace, checkout, sandbox, and using this word for the directory the
Transcript lives in — that one is nobody's to reclaim

**Session Generation**:
Which of a Conversation's Sessions is the current one. A Conversation Key never
changes, so `/new` moves this instead: the Session id derives from the key and
the generation together, and every Conversation starts at the first. Written
down, because a restart that forgot it would resume the context `/new` was used
to drop.
_Avoid_: reset, epoch, version, session number

**Resident Session**:
A Session whose Claude Code process is currently alive, so the next message
skips cold start.
_Avoid_: warm session, active session, hot session

**Session Pool**:
What decides which Sessions are resident, and for how long. It owns spawning,
Eviction, Reaping, and abandoning a Turn that has spent its retry budget, and it
is the only thing that knows whether a Session is being created or reached
again.
_Avoid_: process pool, session manager, cache

**Eviction**:
Ending a Resident Session's process to make room for another one. The Session
survives it — the next message resumes from the transcript on disk — so nothing
the person using it can observe changes.
_Avoid_: killing a Session, closing a Session, expiring

**Reaping**:
Ending a Resident Session's process because it has gone unused, rather than to
make room. Distinct from Eviction only in what prompted it.
_Avoid_: timing out, garbage collection, idling out

**Command**:
One of the two messages roma answers itself instead of handing to Claude Code:
`/stop` ends the work this Conversation has in flight — running, queued, or
still starting — and `/new` gives the Conversation a fresh Session. Recognised in the Core, never in a Channel Adapter, and only when the
whole message is one of the two — everything else, Claude Code's own slash
commands included, is work. A Command is not a Task: it drives no Turn, is not
queued, and is not counted against the concurrency cap.
_Avoid_: slash command (those are Claude Code's, and roma passes them through),
instruction (that is an Outbound Instruction)

**Task**:
One message from one person, from arrival to final result. The unit that is
queued, counted against the concurrency cap, stopped, and audited.
_Avoid_: job, request, run

**Task Queue**:
What decides which Tasks may run right now: Tasks of one Session are serialised,
and three Tasks run at once across all of them. One queue for the whole of roma,
shared by every Core the way the Session Pool is.
_Avoid_: the ingress queue (that is the Transport, and a different queue
entirely), scheduler, worker pool, throttle

**Turn**:
Claude Code's own unit — one message in, one completed response out. An Attempt
that reaches Claude Code drives one, so a Task drives as many Turns as it made
Attempts that got that far — and an Attempt stopped before the message went
drives none at all.
_Avoid_: using this interchangeably with Task; a Task the Shared Window blocked
and roma ran again drove more than one, and the two belong to different systems
regardless

**Attempt**:
One try at serving a Task, paid for by one credential. The layer between a Task
and a Turn, and it exists because a Task is not one try: the Shared Window can
block it, Overflow can be taken on it, and the window can come back — so a Task
makes between one and three, each with its own credential, its own reading of the
window, and its own share of the bill. Which credential answered is which one the
last Attempt was on, and that is what the Task's Audit Record is filed under.
_Avoid_: retry (that is the Retry Storm's unit, and Claude Code's rather than
roma's), pass, go

**Retry Storm**:
A Turn going nowhere but still retrying — a bad credential produces ten retries
across three minutes before the error itself surfaces. roma abandons the Task
once the retry budget is spent, so the slot goes back rather than being held for
a Turn that is not going to arrive.
_Avoid_: backoff, rate limiting, timeout (there is no wall-clock timeout on a
Task; this bounds retrying, not working)

**Startup Self-Check**:
The live Turn roma drives at boot to prove that auth resolves to the credential
it means to run on, and on the pinned model. Failure blocks startup: nothing that
could accept an Ingress Message is built until it has passed.
_Avoid_: health check, preflight, smoke test, and `claude auth status` — that
reports a token valid right up to the moment it 401s, which is why this is a real
invocation instead

### Paying for it

**Shared Window**:
The rolling subscription quota everyone draws on, because everyone shares one
token. When it is spent, everyone is blocked at once — including the token's
owner.
_Avoid_: rate limit, quota, budget

**Overflow**:
Running one blocked Task on metered API billing instead of the Shared Window.
Off by default and offered per-Task at the moment of blocking. Mechanically it is
not a mode: it is the other environment map, chosen per Turn, and it moves back
on its own for the Conversation's next message.
_Avoid_: fallback, API mode, paid mode, spillover

**Parked**:
What a Task is between the Shared Window being spent and it coming back: kept,
said out loud, holding no concurrency slot and no process, and stoppable
throughout. Distinct from queued — the Task Queue decides what may run now, and a
parked Task is waiting on the provider rather than on roma.
_Avoid_: paused, retrying, backing off, queued (that word is the Task Queue's)

**Audit Record**:
The line roma writes when a Task ends: who asked, which Session ran it, how long
they waited, what it cost, and which credential paid. One per Task — a failed or
stopped one included — and the cost on it is the Turn's own delta, never the
Session's running total. It can also be nothing at all: a Turn that began and
never reached a terminal event spent real tokens nothing will ever name, and that
is written down as unpriced rather than as free. Everybody shares one token, so the provider knows only
that somebody spent it; this is the only place the question of who is answerable,
and the only place a calendar month can be added up.
_Avoid_: the bare word "log" for one of these — the Operator Log is the
operational one and the two are not the same thing, so the qualified "audit log"
is the collection and an Audit Record is a line of it. Also: metric, usage
record, telemetry

**Operator Log**:
The running commentary roma writes for whoever is running it: an Eviction, a
Reaping, a credential swap, a refusal. What roma decided and why, as it happens —
never what an agent did, which is the Transcript's, and never the account of the
money, which is the Audit Records'. Nothing is totalled from it.
_Avoid_: audit log (that is the Audit Records), event log (that is nearer the
Transcript), telemetry, metrics
