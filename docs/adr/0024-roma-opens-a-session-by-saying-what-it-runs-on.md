# 24. roma opens a Session by saying what it runs on

Date: 2026-08-06

## Status

Accepted and implemented. `Core.handle` starts the Opening, `Core.#deliverAfter`
is what keeps it first, `WorkRoot` gains a fourth record kind, and `/config`'s
sentence moves into a method the Opening shares.

**Amended by its own implementation, in one place and it is §"It is a message,
before the Acknowledgement".** That section said the Opening is awaited before the
message is dispatched, and named the cost as latency. Both were wrong, and the
correction is marked inline below: awaiting it there moves *everything that makes
a message stoppable and ordered* later, because all of it happens downstream of
that line. Two behaviours this Core is measured on broke, and neither was the one
predicted.

Builds on ADR-0014 and ADR-0016, which made the Chosen Model and the Chosen
Effort roma's own and made asking about them free, and on ADR-0017, which claimed
`/config` and wrote the sentence this reuses without altering a word of it.

**Leaves ADR-0010 untouched.** That record keeps the answer out of the
Acknowledgement. This adds a message *before* the Acknowledgement and changes
nothing about what one says, so the rule it defends — one Conversation is not told
the same thing twice — is the rule this design is shaped by rather than an
obstacle to it.

**Does not open #70.** roma still has nobody it can speak to first: no
Conversation of its own, no identity it holds, no address book. An Opening is a
reply to a message somebody sent, and every constraint below follows from that.

### Verification status

**Nothing here needs measuring, and saying so is the point** — the two ADRs this
builds on both rest on readings of a pinned binary, and this rests on none. An
Opening drives no Turn, reads nothing off the wire, and asks Claude Code nothing.
Both facts in it are roma's own records, already answered by `Core.#modelNamed`
and `Core.#effortNamed` for three spellings.

What could be wrong here is a judgement about what people want to read at the top
of a thread. That is not something a capture would settle.

## Context

A Caller cannot tell what their Conversation is running on without asking, and
the moment it is most likely to have moved under them is exactly the moment
nobody asks.

**`/clear` is the sharp case.** A Chosen Model and a Chosen Effort belong to a
Session, so `/clear` returns a Conversation to the Pinned Model and the Pinned
Effort without anything being deleted — that is ADR-0014's design and ADR-0016
repeats it. What `/clear` answers with is a `command-outcome` carrying a boolean.
It names no model and no effort, because the instruction has nowhere to put one.
So somebody who typed `/model opus` in the morning, cleared the thread after
lunch, and carried on is on the Pinned Model, was told, and was told nothing.

**A restart is the quiet case.** The Pinned Model and the Pinned Effort are fixed
before boot and an operator can move either between deploys. Every Session that
had no Chosen Record moves with them, and nothing in a Conversation says so.

`/config` answers all of this and costs nothing (ADR-0017). It has to be asked
for. The person who most needs it is the one who does not know there is anything
to ask about — which is the same shape as ADR-0023's argument for a button, one
step earlier: free is not the same as reached.

## Decision

**roma's first reply in a Session says what that Session runs on.**

### An Opening is a message, and it goes before the Acknowledgement

Its own message in the Conversation, delivered before the work starts. The
Acknowledgement becomes the second thing roma says rather than the first.

The alternative that looks cheaper — carrying it as the Acknowledgement's first
line — was rejected on what an Acknowledgement *is*. That message is a status
line: it is rewritten every five seconds, it says which tool is running and how
much has been written, and where a Channel cannot edit it is posted once and
nothing follows it. A model and an effort are neither status nor answer; they are
fixed for the whole Task, because `--model` and `--effort` are spawn arguments and
a process started for other terms is swapped rather than reused. Putting a
constant into a message whose whole purpose is to change means either losing it on
the first update or reprinting it on every one — and the second turns one message
into two things at once, which is the boundary ADR-0010 drew.

Prefixing it to the first Result was rejected outright: it would arrive after the
Turn it describes has been paid for, which is a receipt rather than an Opening.

**Amended by the implementation.** This section originally said the Opening is
awaited before the message is dispatched, and that the cost of doing so is a
Channel slow to take it delaying the Task. The cost is not latency. Everything
that makes a message stoppable and ordered happens *after* the point where a
Command is told apart from work — registering the Task so `/stop` can reach it,
and entering the Task Queue — so a message that pauses to open reaches both later
than one that does not. Measured: a `/stop` sent straight after a Conversation's
first message was answered "nothing to stop" while the Task ran on, and two
messages sent together came back in the wrong order.

So the Opening is **started** when the message is dispatched and **waited for at
the Channel**: every instruction a Task or a Relay produces goes out behind it,
through one method they all share. The ordering property is unchanged — the
Opening is still the first thing posted — and it is now a property of the delivery
path rather than of how long a caller was made to wait. The rule this buys is
worth stating on its own: *nothing about an Opening may change when a message
becomes stoppable.*

One consequence is that a message arriving while an Opening is still going out has
to wait for it too, or its acknowledgement is posted above the Opening. That is
why roma holds a promise per Session rather than a flag — the flag would tell the
second message there was nothing to do and let it straight past.

### A Command starts no Session, so a Command prompts no Opening

The trigger is the first message of a Session that needs the Session's process —
a Task, a paid Relay, a free Relay. `Core.handle` already sorts messages into
exactly these three groups, and the Opening sits on the seam after the Command
branch, so one insertion point covers all three.

A Command is excluded because a Command starts nothing: it drives no Turn, needs
no process, and `#runCommand` never reaches the Session Pool at all. `/stop` and
`/clear` on a Conversation that has never worked are answers about nothing having
happened yet.

The exclusion is also what keeps roma from answering one question twice. Three of
the five Commands report what the Session is set to, and `/config` reports
*exactly* the two facts an Opening carries, in the same words. Had Commands
prompted an Opening, a new Conversation whose first message was `/config` would
have received the same sentence twice in a row, and the repair for that would have
been a list of replies that already count — a list whose one silent failure mode
is somebody rewording `/config` and leaving the exemption behind. Excluding
Commands dissolves the problem instead of managing it: in every case where no
Opening is sent, either the Caller has just been told by the Command's own answer,
or there is no Session running for an Opening to describe.

### It is `/config`'s sentence, from `/config`'s methods

The text is what `#answerConfig` produces today, unchanged:

> This conversation is on default (claude-sonnet-5), at default (medium). Change
> either with “/model” or “/effort”.

Built by calling `#modelNamed` and `#effortNamed`, never by reading the Chosen
Records again. `#answerConfig`'s own comment is the argument and it now covers a
fourth caller: *three spellings over two roma-owned facts, not three sources of
truth — and a second reading here is exactly how three spellings would come to
answer differently.* The sentence naming a model the Effort Matrix says takes no
effort rides along for the same reason, because `#modelTakesNone` is inside those
methods' orbit rather than beside them.

Writing a second, friendlier sentence was considered and dropped. Two sentences
saying one thing is two things to keep true, and the failure is invisible: nobody
compares the top of a thread against `/config` a week later.

**No buttons.** ADR-0023 gives `/model` and `/effort` a `choice`, and an Opening
carries a plain `result` like `/config` does. A card offering ten options above a
Task somebody has already sent is an invitation to change the terms of work that
is already running, which is the one thing `#answerModel`'s reply has to say out
loud it does *not* do.

**No new instruction kind.** `kind: 'result'` — text to be posted as its own
message — on the argument the free Relay path already makes for itself: an Adapter
has nothing to do differently with one, and a tenth kind would be a concept every
Channel had to learn for no change in behaviour.

### The record is the Work Root's fifth kind of file

One Opening per Session, so roma has to remember which Sessions have had one. That
record is the Core's own file in the Work Root, keyed by Session id, beside
`.generation`, `.model` and `.effort`.

**Not the Session Pool's spawn file**, which is the obvious candidate and fails
twice:

- **Ordering.** The pool's answer to "is this Session new" does not exist until
  `#spawnNow` runs, and that is inside the Task, after the Acknowledgement has
  been posted. An Opening that waited for it would arrive third. There is no
  arrangement where the pool answers this and the Opening is still the first
  reply.
- **Durability.** `SPAWN_FILE` lives *inside* the Working Directory precisely so
  that ADR-0003's seven-day reclaim takes it — a Session whose directory was
  reclaimed must go on being spawned as new and recovered by
  `transcript-survived`. That is right for the pool and wrong here: a Conversation
  quiet for eight days would be opened again, having forgotten nothing.

And the pool's reading can be wrong in both directions, which `#wrongFlag` exists
to correct *after* the spawn is refused. A message that has been posted cannot be
corrected that way.

**A file rather than a directory**, which is the whole of why this survives: the
Work Root's rule is that a directory is a Session's Working Directory and a file
is a record, and the sweep deletes the first and steps over the second. The rule
now has five dependants rather than four.

**Empty, with existence as the record**, the way `SPAWN_FILE` is. Writing the model
and effort it announced would buy a feature nobody has asked for — re-opening when
the pinned value moves — and Q1 of this design settled that an Opening is once per
Session rather than once per change.

### Written after it is delivered, never before

The record is written when the Channel has taken the message, not when roma
decides to send one. An Opening the Channel refused is one nobody read, and the
next message opens again.

This is the benign direction of a choice that has no safe middle: written first, a
Channel hiccup costs a Conversation its only Opening, silently and permanently.
Written after, the cost of the same hiccup is that the Opening arrives one message
late.

A Task whose Session roma cannot work out gets no Opening and is not made to wait
for one. `sessionFor` can throw — an unreadable generation record — and that
failure already has an owner inside `#runTask`, which answers the Caller with a
`failure`. The Opening declines to duplicate it.

**An Opening may never fail outwards, and since the amendment above that is a rule
rather than a tidiness.** Everything the message goes on to produce waits on the
Opening's promise, so a rejection would reject the Task's own delivery, hand the
Delivery back to the Transport, and redeliver a Turn that has already been paid
for. The write is therefore absorbed like the delivery — and unlike the delivery it
stays claimed, because by then the Opening has been said and only the note of it
was lost.

## Consequences

- `CONTEXT.md` gains **Opening**, and the Work Root's four kinds of file become
  five.
- **A Conversation's first message produces three messages from roma** where every
  other message produces two. That is the price of the Opening being first, and it
  is paid once per Session.
- **Every Session alive when this ships is un-opened**, so the deploy that lands it
  is followed by one Opening in every Conversation that is still being used. That
  is correct — roma has never said this to any of them — and it is a visible event
  rather than a quiet one, so it is named here rather than discovered.
- **The Work Root accumulates one more small file per Session, forever.** Nothing
  reclaims records, by design; this is a fifth of them and the same size as the
  rest.
- **`/config` becomes the fourth spelling of two facts**, where ADR-0017 left three.
  The rule that keeps them honest is unchanged and now has one more dependant.
- **An Opening is not a Task and is audited nowhere.** No queue, no concurrency
  slot, no Attempts, no Audit Record, and nothing on the Operator Log — roma
  decided nothing and refused nothing. A Conversation's Opening is therefore
  invisible to the money, which is right: it spent none.
- **`/stop` cannot reach one**, and there is nothing to reach. It is delivered
  before the Task is admitted and cannot be interrupted usefully.

## Alternatives considered

**The Acknowledgement's first line, or its first frame only.** Rejected above. The
first-frame variant satisfies the words "roma's first reply says it" and loses the
sentence five seconds later, which is worse than not saying it: a notice nobody can
scroll back to is a notice that was never given.

**Prefixed to the first Result.** Rejected. The information's whole value is being
in time to change the answer, and this delivers it after the answer.

**Commands prompt an Opening too.** Rejected above — `/config` verbatim twice, and
the repair is an exemption list with a silent failure mode.

**Every process cold start, rather than every Session.** Rejected. Eviction and
Reaping are invisible to the person using roma by design, and this would make them
the loudest thing in the thread — a Conversation used twice a day would be opened
twice a day, saying nothing that had changed.

**Remembering openings in memory.** Rejected. Every deploy would re-open every live
Conversation, which both defeats the once-per-Session rule and makes the message
false: an Opening is about a Session that has just started, and this would send one
about a Session three weeks old.

**Deriving it from the Working Directory's existence.** Rejected, and it is the
mistake this repository has already made: #105 is the account of it. An Enclosure
is written before the Turn, so a first message with an attachment creates the
directory and the next line reads the Session as one that already exists.

**Speaking first — an Opening when roma is added to a space.** Rejected as out of
reach rather than as wrong. `readIngressMessage` drops everything that is not
`type: "MESSAGE"`, and at the moment somebody adds roma to a space there is no
Conversation Key, so there is no Session for an Opening to be about. Building it
means answering #70 first.

**Doing nothing, on the grounds that `/config` already exists and is free.**
Rejected on ADR-0023's argument one step earlier. `/config` serves the person who
knows the setting can move. The Caller this is for is the one who does not, and the
`/clear` case is the proof: roma performs the change itself, answers, and says
nothing about what it changed.
