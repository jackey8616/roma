# 18. A Relay may cost money, and is governed as a Task

Date: 2026-08-01

## Status

Accepted, and **not implemented**. It depends on the reader #98's step two
builds — `system/compact_boundary` and `compact_result` off stdout, and the
Audit Record's compaction field — and that step is unwritten. The ADR is
accepted ahead of the code the way ADR-0016 and ADR-0017 are: what is decided
here does not change with what the implementation learns, and the one thing that
could change it is named under "Not verified" below.

Widens ADR-0012 through the door ADR-0012 left in its own text — "read-only and
free … becomes the *policy* for what may go on the list — revisable, and
revisited deliberately". The membership rule is revised here. The mechanism, the
whitelist's shape, and the marker exception's reasoning are kept.

**Retires the term Readout in favour of Relay.** ADR-0012 gave the category a
definition that does not rot; it did not give it a name that survives a member
which writes rather than reads.

Answers the question ADR-0012 and ADR-0014 both declined:

> **Let the Readout drive a Turn where the local command cannot answer.** Not
> rejected so much as never needed … the answer should be that such a command is
> a Task and always was.

That answer is kept and completed. It was incomplete because a Task reaches
Claude Code marker-first, as prose, so "it is a Task" meant `/compact` does not
work. What was missing is that a Task's *governance* and a message's *shape on
the wire* are two different questions, and roma had only ever answered them
together.

### Verification status

**Measured, on the pinned build (2.1.220, ADR-0007)** — all of this is #100's,
recorded in `docs/compaction-verification.md`:

- A Compaction announces itself on roma's stdout. The event is
  `system/compact_boundary`, and its payload is **snake_case**
  (`compact_metadata`), not the transcript spelling #98 quoted.
- `trigger` is `E.enum(["manual","auto"])`. Only `auto` has been seen. **The
  `manual` half is this ADR's, and it is unmeasured.**
- A Turn carrying a Compaction cost **4.9×** the same Turn without one
  ($0.0917 against $0.0186 on byte-identical messages) and took **12×** the wall
  clock, 19,487ms of it the Compaction's own `duration_ms`.
- A failed Compaction is not a `compact_boundary`. It arrives on `system/status`
  as `compact_result: "failed"` with `compact_error` carrying a **code**, and
  the Turn around it stayed healthy and answered.

**Read off the bundle, on the pinned build** — #98's second comment, quoting the
manual path's own switch:

```js
switch (p.reason) {
  case "too_few_groups":     throw Error(Chr);
  case "aborted":            throw Error(EV);
  case "exhausted":          throw new V7("Compaction failed · conversation could not be reduced below the context limit");
  case "media_unstrippable": throw new V7("Compaction failed · attached media exceeds size limits");
  case "error":              throw new V7(`Error during compaction: ${p.detail || "unknown error"}`)
}
```

**Read off 2.1.42, which is not the pinned build.** A copy of Claude Code
2.1.42 was to hand and was read; every line below is evidence about *that*
build and must be re-read on 2.1.220 before the implementation rests on it. It
is recorded because two of the three correct a claim in #89.

```
{type:"local", name:"compact",
 description:"Clear conversation history but keep a summary in context.
              Optional: /compact [instructions for summarization]",
 isEnabled:()=>!$6(process.env.DISABLE_COMPACT),
 supportsNonInteractive:!0,
 argumentHint:"<optional custom summarization instructions>"}
```

- **`/compact` takes an argument.** #89's body quotes `argumentHint:""` and
  #89's own later comment quotes the string above. 2.1.42 agrees with the
  comment. The decision below rests on this and it is the line most worth
  re-reading on the pin.
- **No feature gate.** `isEnabled` reads one environment variable `buildEnv`
  owns. It is not fenced behind the remote experiment flag that `/autocompact`
  sits behind (`p2d()` → `tengu_amber_redwood2`), which is what left #98's rung
  1 untried.
- **No aliases.** The descriptor carries none, so `/compact` is one spelling.
  ADR-0013's fault — a spelling roma leaves unclaimed is one somebody is billed
  for — has nothing to bite on here.

**Not verified — the manual path, in any respect.** Every measurement above is
of an *auto* Compaction. What a relayed `/compact` puts on stdout, whether
`too_few_groups` arrives on `system/status` there too or surfaces as the thrown
error the switch suggests, and how a multi-line argument is carried into
`<command-args>`, are all unknown. **One short seam 2 run settles all three**,
and it is cheap — a Session with a handful of messages in it is already a
`too_few_groups`, which is the opposite of `exhausted`'s expense. That run is
step one of the implementation, not of this ADR, because none of the three can
change what is decided here: they change what the reply says, not what the thing
is.

**Not verified — `exhausted`.** Read off the switch above and nothing more.
#98 judged provoking it not worth the money and this ADR agrees.

## Context

Somebody wants to compact a long thread from the Channel, choosing the moment
and choosing what survives.

Auto-compaction does not answer this, and #98's research is the evidence rather
than an intuition: it is on by default, it should stay on, and upstream's own
warning text sells the other half — *"Autocompact will trigger soon, which
discards older messages. Use `/compact` now to control what gets kept."*
Auto-compaction is the net. This is the deliberate act.

roma cannot do it today, and the reason is ADR-0012's fault with a string
ADR-0012 did not fix. `/compact` is not a Command and is not on the Readout
list, so it falls to a Task, so the Caller Marker goes above it, so the message
no longer begins with a slash, so Claude Code answers *about* the command
instead of running it — at `$0.0549` a go.

Neither did it fit any of the three kinds, and #89 read that as needing a
fourth: *relayed to the process as itself, and driving a Turn*. A category with
one member is a poor thing to invent, and #89 said so first.

**It is not a fourth kind. It is the fourth cell of a grid roma has always
had.** Two questions were being answered together because, on the four strings
that existed, they always had the same answer:

|  | given to the model, as prose | given to the process, as a command |
| --- | --- | --- |
| **not governed** — free, unqueued, uncounted | — | **Readout** |
| **governed** — queued, capped, stoppable, audited | **Task** | ***`/compact`*** |

The two definitions already say this, and neither needed changing to see it.
`CONTEXT.md` defines a Readout by **what roma does with it** — "hands to the
Session's process as itself rather than as something for the model to read" —
and defines a Task by **what governs it** — "the unit that is queued, counted
against the concurrency cap, stopped, and audited". Those are different axes.
Their apparent exclusivity was a property of the list's contents, not an
entailment of either word.

Reading it as a missing *category* means inventing queueing, a cap, a stop and a
ledger entry for it. Reading it as a missing *cell* means inventing nothing: the
frame is ADR-0012's, and the governance is the Task path that already runs.

## Decision

**A Relay may drive a Turn. One that does is governed as a Task in every
respect. The category is renamed, and its membership rule is rewritten in terms
of roma's own state.**

### The name is Relay, and Readout is retired

A Readout that discards sixty thousand tokens of conversation and bills five
times a quiet Turn is not reading anything out. ADR-0012 was careful that the
*definition* would not rot and left the *name* naming the four members'
behaviour; widening the membership makes the name the exact kind of lie that ADR
was written to prevent.

ADR-0012's `_Avoid_` list holds `relay`, and that avoidance is reversed
deliberately. It was avoided when every member was a free reading, because
"relay" says nothing about what may go on the list and "Readout" did. Now that
the list spans two cost classes, saying nothing about cost is precisely what the
name should do — the membership rule below carries the whole of what may go on
it.

The rename is mechanical: `src/readouts.ts`, its test, `Core.#runReadout`,
`attributedReadout`, `AuditKind`, `AuditTotal.readouts`, and the `CONTEXT.md`
entry. No behaviour moves with it. The file keeps the line naming Claude Code
2.1.220, so `scripts/claude-code-drift.ts` goes on listing it under what rests
on the pin.

### The membership rule: a Relay changes nothing roma holds a belief about

ADR-0012's rule was "read-only, non-interactive, drives no Turn, changes no
state of the Session or of Claude Code". Two of those four are dropped and one
is rewritten:

> **A Relay is non-interactive, and it changes nothing roma holds a belief
> about.**

What roma holds a belief about is a list, not a judgement:

| roma believes | broken by |
| --- | --- |
| which session id this Conversation resumes to | `/clear` (ADR-0003, ADR-0013) |
| which model this Session runs on | `/model` (ADR-0014) |
| which effort it runs at | `/effort` (ADR-0016) |
| what the settings file every Session shares says | `/config` (ADR-0017) |
| that auto-compaction is on, as a decision roma made | `/autocompact` (#98) |
| **what is in the context** | **nobody — roma never reads the Transcript** (ADR-0005, ADR-0006) |

The last row is why `/compact` passes, and it passes as a consequence of the
rule rather than as an exception carved for it. `/compact` changes Claude Code's
state. It changes nothing that is roma's.

This is a better rule than the one it replaces, for the reason ADR-0012 itself
gives about `shared-window.ts`: it is stated as a claim about **roma's** state,
which roma writes, rather than about Claude Code's behaviour, which moves on
somebody else's release schedule. It still fails closed, is still applied by a
person, and is still re-applied when the ADR-0007 pin moves.

**"Drives no Turn" leaves the rule and becomes the governance question.**

### Governance follows cost, not shape

> A Relay that drives a Turn is queued, counted against the concurrency cap,
> stoppable, Parkable, Overflowable and audited — exactly as a Task is. A Relay
> that drives none keeps ADR-0012's arrangements unchanged.

ADR-0012 exempted a Readout from the cap of three by arguing "no Turn, no money,
no retry", and named the cost it was buying: three people asking what is going
on should not be able to stop the work they are asking about. Not one clause of
that survives contact with a twenty-second, five-cent model Turn. The exemption
is not extended.

`/stop` reaching it is a consequence of the same sentence rather than a second
decision, and it closes the gap ADR-0012 recorded and accepted — "**`/stop`
does not reach a Readout** … a Readout is free and instant". A `/compact` is
neither, and the machinery ADR-0012 judged too wide to build for a free command
is machinery a governed Relay simply has. Upstream agrees that stopping one is
coherent: `aborted` is in the failure vocabulary.

**No carve-out for Overflow**, though #89 asks for one — "a person compacting a
context is not obviously somebody who wants to be offered metered billing". It
is refused on three counts. Overflow is an *offer*, made per-Task at the moment
of blocking, and declining costs nothing (ADR-0002). Suppressing it for one
string is a conditional rule that has to be written, and its content is roma
deciding on somebody's behalf how much of their money is worth spending, which
ADR-0002 refuses in as many words. And the inconsistency lands the other way up:
every other message in the thread would carry the option and this one would not.

The honest counter is recorded rather than hidden: Overflow on a `/compact` buys
no work now. It buys a shorter context for when the Shared Window returns, and
the value of that is the value of the Caller's own summarisation instructions.
That is a thin thing to spend metered money on, and it is the Caller's to
decide.

### `/compact` takes an argument, and the marker goes back in front of it

The frame roma writes:

```
/compact

<from>Ada (users/17)</from>

keep the architecture decisions and anything still unresolved
```

Dropping the argument would leave `/compact` differing from auto-compaction only
in *timing*. "What gets kept" is the other half of the want and is the half
upstream's own warning advertises.

**This restores ADR-0011's rule rather than taking a second exception to it.**
ADR-0012's marker-last placement is safe only because "the whole message must be
exactly one of the four strings, so the Caller contributed no text at all" —
which stops being true the moment an argument is allowed. ADR-0011's rule is
that roma's part comes before the Caller's, and the frame above satisfies it:
what precedes the marker is roma's own literal `/compact`, and every character
the Caller typed follows it. A forged `<from>` in the argument sits after the
real one, exactly as it does in any ordinary Task.

So the exception ADR-0012 opened now has two shapes, and the second is the
weaker one:

| Relay | marker | why it is safe |
| --- | --- | --- |
| takes no argument | after the command | no Caller text exists |
| takes an argument | between the command and the Caller's text | ADR-0011's own ordering |

**Which strings may take an argument is a named list, holding `/compact` and
nothing else.** The shape is ADR-0014's, and its defence carries over verbatim:
what ADR-0003 rejected was a general "begins with a slash and looks like ours"
rule, because such a rule inherits every command a later release adds. A named
list does not grow on its own.

**roma validates nothing in the argument, and this is the first place it relays
Caller-authored free text as a command argument.** `/model opus` has the Model
Menu to check against; `keep the architecture decisions` has nothing. This is
not an escalation — the same person can already put any text in front of the
model as a Task — but it is a real consequence in a shared thread: one person's
instructions decide what survives for everybody. That is the same shape as the
consequence ADR-0014 accepted for a Chosen Model, and it is handled the same
way: the Audit Record answers it afterwards, and nothing announces it at the
time.

The marker travels into `<command-args>` alongside the argument and is therefore
read by the summariser. Accepted: it is roma's own tag wrapping a person's name,
and a name inside a summarisation instruction does not become another
instruction. Recorded here rather than left to be discovered.

### The Audit Record, and a breaking change to the ledger

**`kind` keeps two values. `'readout'` becomes `'relay'`, and no legacy spelling
is kept.**

`kind` names the axis this ADR separated out — the shape on the wire — so a
third value would smuggle cost back into a field that is not about cost. What a
Relay cost is already on the record, in `costUsd`.

The consequence is a genuine breaking change and is chosen with it in view.
`audit-log.ts:475` drops a record whose `kind` it cannot name:

```ts
if (record['kind'] !== undefined && !KINDS.includes(record['kind'] as AuditKind)) return null
```

so every existing Readout record becomes unreadable on the deploy that lands the
rename, and its cost leaves the month's total — which is what the Overflow cap
is enforced against. This is the trap ADR-0012 wrote its optional-field
reasoning to avoid, approached from the other side, and it is accepted for two
reasons. It is **not silent**: `totalFor` already returns `unreadable`, so the
dropped lines are counted where the total is read. And it is **avoidable by
scheduling**: deployed at a month boundary, the dropped records are all in a
closed month and the live cap is untouched. That is a deployment note, not a
design option, and it belongs in the release rather than in the code.

**A Compaction is recorded with #98's field and nothing new.** `/compact` needs
no schema decision at all, which is the orthogonalisation paying for itself:

|  | `kind: 'task'` | `kind: 'relay'` |
| --- | --- | --- |
| `trigger: 'auto'` | auto-compaction; the cost lands on whoever crossed the threshold — #98's unfairness | — |
| `trigger: 'manual'` | — | **somebody typed `/compact`; the cost lands on them** |

The pair answers "who asked for this Compaction" without a field being invented
for the question.

### The drift check moves from the category to the entry

ADR-0012's check — a Readout returning `num_turns !== 0` goes to the Operator
Log — would fire on every legitimate `/compact`, and a check that cries wolf is
a check somebody mutes.

> Each entry on the Relay list carries whether it is expected to drive a Turn.
> The Operator Log gets a line when the entry and reality disagree, **in either
> direction**.

Strictly more than ADR-0012 had. It still catches a free entry that has become
model-driven, which was the whole point, and it now also catches a paid entry
that has stopped driving a Turn — which usually means the command has been
removed or has changed shape under the pin.

### An Acknowledgement, unconditionally, for a Relay that costs

ADR-0012 made the Acknowledgement conditional because "a Readout on a warm
Session returns in **milliseconds**". That premise is measured false here by a
factor of twenty thousand.

The rule is the governance clause again rather than a new condition: a governed
Relay gets the ordinary Task Acknowledgement, and ADR-0012's conditional rule
stays exactly as written for the four free entries it was written for. Left
alone, a `/compact` on a warm idle Session would post nothing and then say
nothing for twenty seconds — which is the failure ADR-0003 named when arguing
the concurrency cap: "unacknowledged waiting causes users to resend, which
compounds the backlog".

**`status: "compacting"` is reported as progress.** The Acknowledgement's
vocabulary is "which tool is running … how much of the answer has been written",
and a Compaction has neither, so without this the Acknowledgement idles for the
whole 19,487ms. It is the same shape of dead stream `readToolStarted` already
exists for.

### What the Caller is told when it fails

By `compact_error`, which is a code rather than a sentence — so this is not the
`shared-window.ts` mistake of building on one build's strings:

| code | the Caller is told | Operator Log |
| --- | --- | --- |
| `too_few_groups` | there is not enough conversation here to compact | no |
| `aborted` | it is their own `/stop`; the existing reply serves | no |
| `exhausted` | this thread is full, and `/clear` is the way out | **yes** |
| `media_unstrippable`, `error` | the ordinary failed-Task reply | yes |

`too_few_groups` is not an operational event — #98's own amendment, after
measuring it as benign and, on the auto path, common. On the manual path it is
likely to be the *most* common failure, because somebody typing `/compact` into
a short thread is exactly "not enough conversation to summarise".

**The question #98 agonised over does not arise here.** It had to argue whether
roma may speak unprompted about something the Caller did not ask for, against
ADR-0010's high bar. A `/compact` was asked for, so the reply is the answer to a
request rather than an additional message, and the bar is not in play.

## Consequences

- `CONTEXT.md` loses **Readout** and gains **Relay** and **Compaction**. **Task**
  stops being identified by governance, since a paid Relay shares it. **Command**
  and **Caller Marker** get the rename and the second marker shape.
- **Session, Turn, Attempt, Parked, Overflow, Task Queue and Acknowledgement are
  untouched.** That is the check on this ADR rather than an observation: had any
  of them needed a new clause, the claim that nothing was being invented would
  be false.
- **The ledger breaks once.** Records written before the rename are unreadable
  after it, counted in `unreadable`, and absent from the month's `costUsd`.
  Land it at a month boundary.
- **`/compact` alone is a button nobody presses at the right moment.** #98 put
  it plainly — "a Caller will not generally notice a context filling up" — and
  deliberate action requires knowing when to act. The pre-emptive warning #98
  deferred behind this ticket is now unblocked and is deliberately not decided
  here: it needs its own argument to revive the context arithmetic ADR-0012
  rejected, and it is roma speaking unprompted, which is ADR-0010's territory
  and nothing to do with relaying a command. Until it lands, this feature serves
  people who run `/context` — who are the people who least need it.
- A `/compact` now competes for one of the three concurrency slots, and it holds
  one for about twenty seconds. A free Relay never did.
- One Caller's summarisation instructions decide what survives for everyone in
  the thread, and nothing announces it. Answerable afterwards on the Audit
  Record; the same trade ADR-0014 took for a Chosen Model.
- The Relay list now spans two cost classes, so the re-audit that follows the
  ADR-0007 pin has to ask a second question of each entry — not only "is this
  still safe" but "does it still cost what the list says".
- roma gains its first relayed free text. Nothing validates it, and nothing can.

## Alternatives considered

**Invent the fourth kind, as #89 proposes.** Rejected on what it costs rather
than on taste. The new category would need queueing, a cap, a stop, a park and a
ledger entry — five things Task already has and has tested — and every one of
them is a fresh opportunity to diverge from the path that works. #89's own
warning applies to itself: a category invented for one member tends to be a
special case wearing a category's clothes.

**Do nothing, and let `/clear` be the answer.** Rejected. `/clear` discards; the
want is a summary. Upstream distinguishes the two in its own telemetry
(`compact_auto`, `compact_manual`) and in the warning it shows users.

**Put `/compact` on the list and leave the membership rule alone.** Not
available: the rule's fourth clause excludes it, and deleting that clause admits
`/clear` and `/model`. Rewriting the clause in terms of roma's own state is what
this ADR does instead, and it keeps both of those out by construction.

**Keep the name Readout.** Rejected, and it is the cheapest option — zero churn.
The name would then have to be carried by its definition against its own
dictionary meaning, in a glossary written for people who have not read the
definition yet. The counter-argument is real and is recorded: if the list stays
mostly readings, renaming the category for one member is the mirror image of
inventing a category for one member. It is judged the lesser risk because the
new rule admits any command that leaves roma's five beliefs alone, and Claude
Code adds commands every release.

**A first version with no argument.** Rejected, though it needs no new safety
argument at all — the whole-message rule and marker-last would both stand
untouched. What it ships is the half of the want that auto-compaction already
covers.

**Keep the argument but keep the marker last.** Rejected outright: it puts
Caller text ahead of roma's marker, which is the forgery ADR-0011 exists to
prevent.

**Exempt `/compact` from Overflow.** Rejected above. Recorded because #89 asks
for it and the instinct behind it is sound — the money buys little. The answer
is that it is an offer, and whose money it is decides who declines it.

**Keep a legacy `'readout'` spelling in `KINDS`.** Rejected by the author of the
ledger's own convention, deliberately: the migration cost is one visible,
countable, schedulable month boundary, and the alternative is a synonym that can
never be deleted and has to be explained to every future reader of a two-value
enum with three values in it.

**One ADR covering this and #98.** Rejected. #98 decides how roma *records*
something it cannot prevent; this decides whether somebody may *ask* for it, and
that one widens a safety rule and retires a term. Folded together, the widening
would ride into the repository inside a document about bookkeeping.
