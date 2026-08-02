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
`/clear` can move — which is why roma needs no database.
_Avoid_: thread id, chat id, room id

**Caller**:
Whoever sent one message, in two halves: the Channel's own name for them, which
is stable and unique, and the readable name beside it, which is neither and can
be missing. A Conversation has no one Caller — a thread is many people sharing
one Session, so the Caller is a property of a message and never of a Session.
It goes three places and no others (ADR-0009): above every message Claude Code is
given, out on every Outbound Instruction so a reply can be addressed, and onto
the Audit Record — which is still the only place *spending* can be attributed to
a person, because the provider attributes none of it (ADR-0002). The Core prints
it and never interprets it: nothing compares one, parses one, or decides anything
by one.
_Avoid_: sender (that is Chat's name for the field an Adapter reads, not roma's
name for the person), user (that is Claude Code's word for the other end of a
Turn), author, requester, owner (a Task has no owner — it has somebody who asked)

**Caller Marker**:
The line roma writes above every message Claude Code is given, naming that
message's Caller. Two rules: it is present on everything the model reads as
content — a message without one reads as the same person again, which is the
misattribution it exists to prevent — and roma's part is tagged and comes
**before anything the Caller typed**, because the rest is what somebody typed and
anybody can type something that looks like this. Said as "tagged" rather than
"the first line" because an Enclosure adds a second tag above the same message,
and a rule counting lines would have to be restated every time one is added.
A Relay moves it, and one kind of Relay drops it; both are bounded and argued. A
Relay that is the whole message carries the marker *after* the command, which is
safe only because the Caller supplied no text at all (ADR-0012). A Relay carrying
an **argument** carries no marker — the only message roma writes without one
(ADR-0018). The reason is that an argument is not content the model attributes to
anybody: a marker says who sent a message, an argument says what to keep, and what
to keep legitimately names other people, so inside one string the two are the same
shape. A summariser given both was measured crediting both. What the marker would
have bought there is on the Audit Record instead, which carries the Caller already.
_Avoid_: prefix, header, tag, and using this for the @-mention in a reply — that
one is the Channel's way of addressing a person and is not this. Also: reading a
`<from>` inside a Relay's argument as one of these — there it is something a
Caller typed, and nothing tells it apart from one roma wrote

**Ingress Message**:
What an Adapter hands the Core: a Conversation Key, a Caller, the text, and any
Enclosures. Everything else the Channel knew is gone by this point.
_Avoid_: event, payload, request

**Enclosure**:
Something sent along with a message rather than typed into it — a pasted
screenshot, a log file. roma writes it into the Working Directory under a name
roma chose and tells the agent where it is; what the sender called it travels
beside the path as a string and is never made into one, which is the whole of why
a filename nobody vetted is safe to carry (ADR-0011). A message with one is a
request whether or not it has any text: what is not a request is a message with
nothing in it at all.
_Avoid_: attachment (that is the Channel's word for the thing upstream, and the
two are not the same object — an Enclosure is named by roma and the Channel's is
not), file (so is everything else in a Working Directory), upload, payload

**Outbound Instruction**:
What the Core hands back to an Adapter — the result of a Task, why there isn't
one, or what the Task is doing meanwhile. It says what happened and whose it is,
never how either should look: how a failure reads and how a person is addressed
are the Channel's.
_Avoid_: response, reply, command (a command is `/clear`, `/model` or `/stop`)

**Acknowledgement**:
The one message roma posts as soon as a Task arrives and then keeps editing
while it runs — that it is waiting, which tool is running and enough of its
command to tell one call from another, how much of the answer has been written.
One per Task, throttled, and never the answer itself: the Result is always a
separate message, and an Acknowledgement that showed the prose would be saying
the same thing twice in one Conversation (ADR-0010). Where a Channel cannot
edit, the acknowledgement is posted once and nothing follows it.
_Avoid_: status message, progress bar, typing indicator, describing this as
showing the answer — it says that an answer is being written, not what it says —
and describing it as showing the command, which is a beginning long enough to
tell two tool calls apart and no more

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
Where a Session does its work — created empty, and roma still checks nothing out
into it: the agent clones what it was asked about (ADR-0008). Two things roma
does put there: an Enclosure, which is not code and came from a person rather
than from GitHub (ADR-0011), and a file the Session Pool writes at every spawn,
which is how it tells creating a Session from reaching it again. That file rather
than the directory's own existence *because* of the Enclosure — writing one
creates the directory, so for as long as existence was the record, a first
message carrying an attachment was reached for as a Session that had never been
written. roma's, unlike the Transcript: roma makes it and ADR-0003 reclaims it
after seven idle days — spawn file and all, which is what keeps a reclaimed
Session being spawned as new and recovered by resuming. It is
named here because it is the Transcript's opposite number and the two are easily
mistaken for one kind of thing — they sit side by side and have opposite
lifetimes, because losing the other destroys the only account there is of what an
agent did. Losing this one used to be described as costing a checkout, and since
ADR-0008 that undersells it: it can hold work an agent did and never pushed, and
the Transcript's account of that is prose rather than a diff. The seven days
still run, unexamined — the cost is accepted, not overlooked.
_Avoid_: workspace, checkout, sandbox, and using this word for the directory the
Transcript lives in — that one is nobody's to reclaim

**Session Generation**:
Which of a Conversation's Sessions is the current one. A Conversation Key never
changes, so `/clear` moves this instead: the Session id derives from the key and
the generation together, and every Conversation starts at the first. Written
down, because a restart that forgot it would resume the context `/clear` was used
to drop.
_Avoid_: reset, epoch, version, session number

**Compaction**:
Claude Code replacing a Session's accumulated conversation with a summary so that
it still fits. Claude Code's mechanism whichever way it starts, and it starts two
ways: on its own when the context fills, which is the default and which roma
neither times nor prevents — leaving it on is roma's decision rather than a
condition roma is under (ADR-0018) — or because somebody asked, with `/compact`,
which roma carries as a Relay and which is the only version where anybody chooses
the moment or says what should survive it. Named here for the money: a Compaction
happens *inside* a Turn and costs several times what that Turn otherwise would, so
the automatic kind lands on the Audit Record of whoever happened to send the
message that crossed the threshold — and a Conversation is many people sharing one
Session. The asked-for kind lands on the person who asked. Adjacent to `/clear`
and not the same: `/clear` gives the Conversation a new Session and drops the
context outright, a Compaction stays in the same Session and keeps a summary. A
failed one is a third thing again, and how serious it is depends on why: too
little conversation to summarise is benign and is the common one, while a context
that cannot be reduced below the limit is a Session that will not serve another
Turn. On the automatic kind Claude Code says which by a code rather than a
sentence, and roma answers it three ways rather than two: **benign** is told to
nobody, **unreducible** goes to the Operator Log and to the Caller with `/clear`
named, and **unexplained** — a code roma has never seen — goes to the operator and
no further, because telling somebody their thread is finished is a sentence roma
has to be able to stand behind (ADR-0019). On the asked-for kind roma judges
nothing: the same field carries a **sentence** there rather than a code, so the
Caller gets Claude Code's own words relayed and the Operator Log gets nothing.
Not a gap left open — the alternative is roma enumerating one build's error text,
which is a mistake it has made once already — and the repair is deferred rather
than lost, because a Session that truly cannot be reduced fails the next ordinary
message on the automatic path, where the code is a code.
_Avoid_: clearing (that is `/clear`, and it is roma's), summarising (that is how
it works, not what it is), truncation (nothing is cut off — older messages are
replaced), and using this for anything that happens to the Transcript, which loses
nothing because roma never deletes it

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
One of the five messages roma answers itself instead of handing to Claude Code:
`/stop` ends the work this Conversation has in flight — running, queued, or
still starting — `/clear` gives the Conversation a fresh Session, `/model` sets
its Chosen Model, `/effort` sets its Chosen Effort, and `/config` says what this
Session is set to and refuses to set anything else. Recognised in the Core, never
in a Channel Adapter, and only when the whole message is one of them — everything
else is work, apart from the few Claude Code commands a Relay carries. `/clear`
answers to `/reset` and `/new`, and `/config` to `/settings`, because those are
Claude Code's own spellings and a spelling roma leaves unclaimed is one somebody
is billed for (ADR-0013, ADR-0017). Three of the five take an argument, and only
a listed head may: nothing else does, which is what keeps the whole-message rule
from widening into the prefix match ADR-0003 refused. That list is now three
entries rather than one, so "a named list does not grow on its own" has become a
thing somebody has to keep true rather than an observation. A Command is not a
Task: it drives no Turn, is not queued, and is not counted against the
concurrency cap.
_Avoid_: slash command (those are Claude Code's, and a Relay is the only way
any of them reaches it), instruction (that is an Outbound Instruction)

**Relay**:
A message roma hands to the Session's process as itself rather than as something
for the model to read — one of a short list of Claude Code's own commands. Named
by what roma does with it rather than by what it costs, because a term defined by
one build's behaviour is a term that turns false on somebody else's release
(ADR-0012). It was called a Readout while every member read a value out, and that
name stopped being true of the list the moment one of them summarised instead
(ADR-0018). Not a Command: it needs the Session's process, so it queues. Whether
it is a Task is the wrong question, and asking it that way is what made `/compact`
look like a fourth kind of message — a Relay names the **shape a message takes on
the wire**, a Task names **what governs it**, and those are different axes. A
Relay that drives a Turn is governed exactly as a Task is: queued, counted against
the cap, stoppable, Parkable, audited. One that drives none is free of all of it.
The membership rule is that **a Relay changes nothing roma holds a belief about** —
which session id a Conversation resumes to, which model and effort it runs on,
what the settings file every Session shares says, that auto-compaction is on. roma
holds no belief about what is in a context, which is the whole of why `/compact`
may be relayed and `/clear`, `/model`, `/effort`, `/config` and `/autocompact` may
not. Where the Caller Marker sits turns on whether the Caller supplied text: a
Relay that is the whole message carries it after the command, and one carrying an
argument carries none at all — the only message roma writes without one, and the
Caller Marker's entry is where that is argued.
_Avoid_: Readout (the retired name, and wrong for a member that writes rather than
reads), passthrough, slash command (that is Claude Code's name for what a Relay
carries, not for the carrying), and using this for `/stop`, `/clear`, `/model`,
`/effort` or `/config` — those are roma's own and are Commands. The last two are
the sharpest case for the membership rule, because both are free and
non-interactive on the pinned build and neither may be relayed: `/effort` sets a
value that lives in the process and dies with it, and `/config` writes a settings
file every Session in the deployment shares (ADR-0016, ADR-0017)

**Task**:
One message from one person, from arrival to final result, given to the model to
read. The unit a Caller belongs to, since one Conversation's two Tasks can belong
to two people. It is queued, counted against the concurrency cap, stopped and
audited — and that list stopped *identifying* it at ADR-0018, which governs a
Relay that drives a Turn in exactly the same way. What tells the two apart is what
reaches Claude Code: a Task arrives as prose with the Caller Marker above it, a
Relay arrives as a command.
_Avoid_: job, request, run, and identifying this by the governance alone — a Relay
that costs money shares every part of it

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
could accept an Ingress Message is built until it has passed. It also asks the
probe's own process what effort it is on, and that one does **not** block — it is
written to the Operator Log and boot continues, because what it reads back is a
sentence rather than a field, and a reworded sentence should not be able to stop a
deployment (ADR-0016).
_Avoid_: health check, preflight, smoke test, and `claude auth status` — that
reports a token valid right up to the moment it 401s, which is why this is a real
invocation instead

**Pinned Model**:
The model roma runs every Session on, unless that Session has a Chosen Model. One
per deployment, fixed before boot, and proved at startup against what Claude Code
says it resolved to — because the model follows the credential and moves without
saying so (ADR-0003). Not a fallback and not Claude Code's own default, which
never runs: this is what roma insists on.
_Avoid_: default model (that is the argument `/model default` takes, not the name
of the thing it returns to), the model, configured model

**Chosen Model**:
The model one Session runs on because somebody said so, in place of the Pinned
Model. Roma's to keep rather than the process's — a model handed to a process
lives and dies with it, and processes end for reasons nobody using them can
observe. It belongs to a Session and not to a Conversation, which is why clearing
a Conversation returns it to the Pinned Model without anything being deleted
(ADR-0014). Almost every Session has none.
_Avoid_: override, preference, model setting, session model (that reads as
whatever model a Session is on, which for nearly all of them is the Pinned Model)

**Model Menu**:
The short list of models a Caller may pick a Chosen Model from, and the whole of
what stops one person moving everybody's Shared Window onto something costlier
without anybody agreeing to it. Roma's own rather than everything Claude Code
would take — it accepts arbitrary model ids, so no list roma held could ever be a
complete check, which makes this an offer rather than a filter. Named for the
reason an Installation is: a term that is the whole of a security property should
be a term.
_Avoid_: whitelist, allowlist (that is its shape, and the word is the Relays'),
supported models (roma is not saying the rest do not work), model list

**Pinned Effort**:
How hard roma asks the model to think, on every Session that has not been moved.
The Pinned Model's opposite number and argued the same way: it is a thing that was
always being set — by a settings file roma neither writes nor reads — and pinning
it does not change what happens, it makes roma able to say what happens
(ADR-0016). One per deployment, fixed before boot, and carried on every spawn so
that no Session runs on an effort nobody chose.
_Avoid_: default effort (that is the argument `/effort default` takes, not the
name of the thing it returns to), effort setting, reasoning level

**Chosen Effort**:
The effort one Session runs on because somebody said so, in place of the Pinned
Effort. Roma's to keep rather than the process's, for the reason a Chosen Model is
— Claude Code's own `/effort` says `this session only`, and a session is a process,
and processes end for reasons nobody using them can observe. Belongs to a Session
and not to a Conversation, so `/clear` returns it to the Pinned Effort without
anything being deleted.
_Avoid_: override, preference, thinking budget (that is the provider's word for
one mechanism behind this, not roma's word for the choice)

**Effort Menu**:
The levels a Caller may pick a Chosen Effort from — every level the pinned build
has, which is what makes it unlike the Model Menu. It is still a spending boundary
and not a typo filter: what it holds back is not a level but `ultracode`, which is
not a level at all but a licence for one Task to become a fleet, and which
therefore reaches roma only through the operator (ADR-0016).
_Avoid_: effort levels (that is the provider's list; this is roma's offer),
whitelist, allowlist

**Effort Matrix**:
Which models take an effort at all, extracted from the pinned build before an
image ships. It exists because the one thing that would settle the question at
runtime is invisible: the level a Session was given is echoed back whether or not
the model will use it, and what the model actually receives is never on the wire
roma can see. So roma reads it in advance, off the binary it is about to ship,
and uses it to say something and to record something — never to refuse anything
(ADR-0016).
_Avoid_: support table, capability matrix, and calling it measured — it is read
from a build, and the reading can be wrong in ways only a person notices

### Reaching the code

**Installation**:
Which repositories roma can reach at all. A GitHub App is installed on a list of
them, and roma acts as that App rather than as anybody. Because no Conversation
is bound to a repository — the agent clones what it was asked about, and roma
performs no checkout — this list is the *only* boundary there is: every
Conversation reaches all of it, and so does everyone who can message roma
(ADR-0008). Named here for that reason and not for GitHub's sake: a term that is
the whole of a security property should be a term.
_Avoid_: the App (that is the thing installed, not what it reaches), repo access,
scope, permissions (those are what an Installation may *do*, which is a second
question)

**Installation Token**:
The credential roma mints so that a Session's tools can reach the Installation.
An hour long, asked for at the moment a tool needs one, and never put in a
process environment — an environment is fixed at spawn and would be stale within
the hour, and a token that reaches a Transcript is in a record roma never
deletes. The Minter holds the App's private key and mints; a Credential Shim
holds nothing. It is not a boundary against the agent, which has a shell and can
print it — what it bounds is how long a token that escapes is worth anything.
_Avoid_: Credential (that word is taken, and by the other provider entirely —
see Shared Window and Overflow), Repository Token (it is scoped to the whole
Installation and a name should not claim otherwise), GitHub token, PAT, secret

**Minter**:
The only thing that holds a long-lived key, and therefore the only thing that can
produce something short-lived from one: the App's private key and an Installation
Token, and — where a deployment has a Cloud Reach — the service account key and a
Cloud Token. Named because it carries the one absolute rule in this area — a
long-lived key never enters the space the agent can reach — and a term that is the
whole of a security property should be a term. One term for both because it is one
rule; what differs is which provider is on the other end, and that is the Minter's
business and nobody else's. The Core sees a port for obtaining a credential and
nothing else.
_Avoid_: token service, credential provider, GitHub client (it is not a general
client for the product; it does this and nothing else), and naming one of the two
keys as *the* private key now that there are two

**Credential Shim**:
The thin client in the agent's userland that asks the Minter for an Installation
Token on a tool's behalf. One concept with two instances — a `git` credential
helper, and something standing in front of `gh` — because the two tools ask for
a credential in incompatible ways and neither may be handed one that outlives
the hour. It holds nothing, decides nothing, and is **not** a boundary against
the agent: the agent has a shell and can invoke either one itself.
_Avoid_: helper (that is `git`'s word for one of the two, and using it for both
hides the other), wrapper, proxy (a proxy sees the traffic; this fetches one
string), adapter (that word is a Channel's)

### Reaching the cloud

**Cloud Reach**:
What the agent can touch in Google Cloud at all. One identity somebody decided
on, and the roles they gave it are the whole of the boundary — every
Conversation reaches all of it, and so does everyone who can message roma. roma
neither sets it nor can check it: it is told which identity to hand over and
nothing about what that identity may do, so work refused for want of a role is
refused by Google and never by roma. Named here for the reason an Installation
is: a term that is the whole of a security property should be a term.
Deliberately **not** the identity roma itself runs on — one that could reach
roma's own ingress could end roma quietly, and a deployment where those two are
the same has no boundary at all (ADR-0015). Most deployments have none, and a
deployment with none has no Cloud Shortcut either: the Reach is what there is to
reach, so without one there is nothing to be handed.
_Avoid_: Installation (that is GitHub's; the two are the same idea on two
providers, and saying either for the other hides which one a sentence is about),
project (a Reach may span several, and need not include roma's own), service
account (what it is made of, not what it bounds), permissions, scope

**Cloud Token**:
The hour-long credential roma mints so that a Session's work can reach the Cloud
Reach. The Installation Token's opposite number, and deliberately the same in
every property that one was argued for: minted at the moment something needs one,
never put in a process environment — which is fixed at spawn and would be stale
within the hour — and never written anywhere that outlives the command it was
made for. What it is minted *from* is the Minter's alone and the agent never sees
it (ADR-0015). Enough to do the work and not enough to keep: an hour after it
escapes it is worth nothing.
_Avoid_: Cloud Key (there is no such term — the thing it is minted from belongs
to the Minter's definition and to nothing else), Installation Token (that one is
the other provider's), access token (Google's word for the wire format, not
roma's for what it hands over), credential (that word is the Shared Window's and
Overflow's)

**Cloud Shortcut**:
The one command roma provides for getting a Cloud Token, so that reaching the
Cloud Reach costs nobody a Turn. Named for what it is rather than for what it
does: there is a long way round — writing the call by hand against Google's own
API, with what is already in the image because roma is a Node program (ADR-0015)
— and this is the short one. It therefore does not have to be complete, and is
not: where it does not go far enough the agent writes that call itself, which is
a use of it working as intended rather than a gap in it. What the long way round
is *not* is a second way to obtain a Cloud Token: minting needs the key, the key
is the Minter's, and the agent can narrow what it was given but never widen it.
Not a Credential Shim: a Shim
occupies the name of somebody else's tool so that the ordinary path is the
correct one without anybody choosing it, and this is a command that can simply go
unused. Like a Shim, it is **not** a boundary — it saves money, and nothing else.
_Avoid_: Credential Shim (see above), helper (that is `git`'s word, and the
Shims' to refuse), SDK, client library, wrapper, and describing it as how an
agent reaches the cloud — it is one way, and the cheap one

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
The line roma writes when a Task ends: the Caller, which Session ran it, how long
they waited, what it cost, which credential paid, which model ran it, what effort
it ran at, whether a Compaction happened inside it and who asked for that, which
repositories it minted an Installation Token for, and whether it used the Cloud
Reach. The model is here because a
Chosen Model is a Caller moving the shared bill and nothing else would remember
which Task did (ADR-0014). The effort is here for the same reason and is weaker
evidence, and says so: it is what roma sent and what the Effort Matrix says the
model does with it, rather than anything roma watched — and where the Matrix says
the model takes no effort at all, the record says that instead of naming a level
nobody ran at (ADR-0016). The Compaction is here because it is the largest
unexplained variation there is in what a Task costs — measured at 4.9 times a
quiet Turn — and because the same field says whether that money was somebody's
choice or somebody's bad luck: an automatic one is a bill for a thread the whole
Conversation filled, an asked-for one is a bill for a `/compact` (ADR-0018). The
repositories are what roma can honestly know:
git names the repository every time it asks for a credential, so what a Task
reached for is free — and what it did once it got there is not, since learning
that would mean reading the Transcript. The Cloud Reach is a yes or a no and
never a count: one Cloud Token does unlimited work for an hour, so a number would
be read as a measure of activity roma does not have — and on that side even the
destination is not free, since a request for a Cloud Token carries none
(ADR-0015). One per Task — a failed or
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
Reaping, a credential or model swap, a refusal. What roma decided and why, as it happens —
never what an agent did, which is the Transcript's, and never the account of the
money, which is the Audit Records'. Nothing is totalled from it. A *failed*
Compaction is in here and a successful one is not, which is the rule rather than
an exception to it: the first can mean a Session that will not serve another
Turn, which roma has a repair for, and the second is somebody's bill (ADR-0019).
One Compaction is in neither, and for the same rule read the other way: a
`/compact` that failed is the answer to a request rather than something that
surprised roma, so it goes to whoever asked and no further.
_Avoid_: audit log (that is the Audit Records), event log (that is nearer the
Transcript), telemetry, metrics
