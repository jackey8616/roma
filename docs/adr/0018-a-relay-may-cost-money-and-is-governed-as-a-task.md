# 18. A Relay may cost money, and is governed as a Task

Date: 2026-08-01

## Status

Accepted, and **implemented** (#89). The rename, the argument, the paid Relay's
governance, the drift check's new key, the replies and the ledger migration are
all in. What it depended on was already built: ADR-0019 landed `readCompaction`
and `readCompactionFailure`, the Audit Record's optional `compaction` field
carrying `trigger`, and `compaction.ts` (#115).

Two things this document left to the implementation, decided there and recorded
here because they are decisions rather than mechanics:

**The code-keyed classifier is reconciled by asking whose Compaction it is.**
`compaction.ts` classifies a failure by **code**, with
`BENIGN = ['too_few_groups', 'aborted']` and everything unrecognised landing in
`unexplained`. On the manual path `compact_error` is a **sentence** — `"Not enough
messages to compact."` — so the commonest manual failure there is would classify
as `unexplained` and write an Operator Log line about a Turn that was fine. The
fix is not to enumerate sentences, which this ADR names as the `shared-window.ts`
mistake in a new hat, and it is not to re-key the classifier: **a Compaction that
fails inside a Relay roma sent is that Relay's own answer, and roma classifies
nothing.** The Caller asked, so the Caller is told, in Claude Code's own words,
and the operator hears nothing. What it gives up is stated rather than hidden: an
`exhausted` on this path reaches the Caller without roma's "and `/clear` is the
way out" beside it. The repair is deferred rather than lost — a Session that
genuinely cannot be reduced fails the *next* ordinary message on the auto path,
where the code is a code and ADR-0019's machinery reads it properly. #118 is
answered by this.

**The drift check's new key needed a floor, and a capture is why.** This ADR
specifies "the `modelUsage` output-token delta, summed across models". The
implementation found that the sum is not monotonic: in
`three-turns-one-process.jsonl` — one process, the pinned build — the third Turn
drops the `claude-haiku-4-5` entry altogether and reports fewer `outputTokens`
for `claude-sonnet-5` than the Turn before it, while `total_cost_usd` climbs as
it should. A plain delta reads that as a negative Turn, which is harmless, and
leaves a baseline below where it had been, which is not: the next Turn to report
normally would show a large positive delta and the check would accuse an innocent
entry. So the baseline is a **high-water mark** and a backwards reading reports
zero. The cost is that real work immediately after such a reading is
under-counted, which is the right way round for a one-directional alarm — it can
fail to fire, and it cannot fire wrongly. `total_cost_usd` is deliberately *not*
treated this way: it is a figure things are billed from, and it does not exhibit
this.

**Amended 2026-08-01, and this one is to the decisions rather than only to the
evidence.** It was written the same day, on facts read off the pinned build and
on the auto-path measurements #100 had taken; it then said the manual path was
"not verified in any respect" and that one seam 2 run would settle it. Two runs
followed — 9 Sessions at $0.7685, then a 24-Session frame survey at $2.5421 —
and four of this ADR's supporting decisions did not survive them:

| what changed | why |
| --- | --- |
| The drift check's key: `num_turns` → the `modelUsage` output-token delta, one direction | a paid Relay reports `num_turns: 0`. The replacement written here could not have been built, and ADR-0012's original was narrower than its own table claims |
| The failure table, split by `compact_error` → deleted; roma relays Claude Code's own sentence | `compact_error` is a code on the auto path and a **sentence** on the manual one. The table was the `shared-window.ts` mistake this ADR named and then made |
| The frame: marker between the command and the Caller's text → **no marker in an argument at all** | a summarisation instruction legitimately names other people, so roma's marker and a mentioned name are indistinguishable inside one string. Measured: the summariser credits both |
| Success has a reply | a successful `/compact` returns `result: ""`. Nobody had asked what the Caller sees |

**What did not change is everything the ADR is for**: no fourth kind, the two
axes, the rename to Relay, the membership rule stated in terms of roma's own
state, and governance following cost. Each of those was strengthened by the runs
rather than dented. Amended inline rather than superseded because this document
is a day old, unimplemented, and the decisions repaired are its supporting
machinery — the precedent is ADR-0014, which marks its amendments the same way.
Each amended section says so where it sits, and what it used to say is under
"Alternatives considered".

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
- `trigger` is `E.enum(["manual","auto"])`.
- A Turn carrying a Compaction cost **4.9×** the same Turn without one
  ($0.0917 against $0.0186 on byte-identical messages) and took **12×** the wall
  clock, 19,487ms of it the Compaction's own `duration_ms`.
- A failed Compaction is not a `compact_boundary`. It arrives on `system/status`
  as `compact_result: "failed"` with `compact_error` carrying a **code**, and
  the Turn around it stayed healthy and answered.

**Measured, on the manual path** — `docs/manual-compaction-verification.md`,
9 Sessions, $0.7685, and the Transcripts read off disk afterwards for nothing:

- `trigger: "manual"` is real and the event is shaped exactly like the auto one,
  through the same `status: "compacting"` → `compact_result` → `compact_boundary`
  sequence. **One reader serves both paths.**
- A manual `/compact` reports **`num_turns: 0`** while moving `total_cost_usd` by
  **$0.0453** over **28,545ms**. `duration_api_ms` is `0` and the top-level
  `usage` is all zeros; only `modelUsage` moves (`+2,019` input, `+1,978` output).
- `compact_error` on this path is a **sentence** — `"Not enough messages to
  compact."` — and the same sentence arrives in the terminal event's `result`,
  free, in 29ms, with `is_error: false`.
- A **successful** `/compact` returns `result: ""`.
- The Caller Marker does reach the Transcript, in `<command-args>`, and it
  survives the Compaction: the command entry is parented onto the compaction
  summary rather than onto what was dropped. `<command-args>` never appears on
  **stdout**, which is a different statement and was briefly confused for this
  one.

**Measured, on the frame** — `docs/compact-frame-survey.md`, 24 Sessions,
$2.5421, six arms over one ordinary conversation, reading rules frozen before the
first run:

- **Marker-first and marker-last are indistinguishable** on every variable at
  n=5. This ADR argued the position at length; the survey neither supports nor
  contradicts it, and the position below is therefore settled by argument, which
  is now on the record as such.
- **A named instruction draws suspicion; the marker alone does not.** Marker plus
  instruction: 9/10 summaries carry injection language. Instruction alone: 1/5.
  Marker alone: 0/3. (Fisher, two-tailed, on the first two: p = 0.017 — the one
  comparison in the survey that separates at this n.)
- **With no marker, nothing misattributes.** 5/5 credited the request to nobody.
- **With roma's marker first and a second `<from>` behind it, the summariser
  credits both**, 3/3, and in one run called both fake.
- **A Caller-typed `<from>` produces a `<command-args>` entry structurally
  identical to the one roma writes.** Nothing downstream distinguishes them.

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

**Read off the pinned build (2.1.220), the whole descriptor:**

```
{type:"local", name:"compact",
 description:"Free up context by summarizing the conversation so far",
 isEnabled:()=>!Z.DISABLE_COMPACT,
 supportsNonInteractive:!0,
 argumentHint:"<optional custom summarization instructions>",
 thinClientDispatch:"post-text"}
```

- **`/compact` takes an argument, and this is the pin saying so.** #89's body
  quotes `argumentHint:""` and #89's own later comment quotes the string above.
  The body is simply wrong; the comment is right. The argument decision below
  is the one that rests on this line, and it now rests on a reading of the build
  roma ships.
- **There is exactly one descriptor.** `name:"compact"` occurs once in the
  build. `/model` has two — a `local` and a `local-jsx`, with `_n()` deciding
  which answers (ADR-0014) — and `/compact` has no such question to settle.
- **No feature gate.** `isEnabled` reads one environment variable `buildEnv`
  owns. It is not fenced behind the remote experiment flag `/autocompact` sits
  behind (`p2d()` → `tengu_amber_redwood2`), which is what left #98's rung 1
  untried.
- **No aliases.** The descriptor carries none, so `/compact` is one spelling.
  ADR-0013's fault — a spelling roma leaves unclaimed is one somebody is billed
  for — has nothing to bite on here.

Re-read on the pin at the same time, because this ADR leans on all three and
each was previously somebody else's reading: the manual path's failure switch
(`case"too_few_groups":throw Error(Chr)`, the same identifier #98 quotes), the
`enum(["manual","auto"])` that makes an asked-for Compaction expressible at all,
and the snake_case mapper on the way out (`compact_metadata:Zvr(r.compactMetadata)`).
All three are present and say what #98 said they say.

**How to re-read it when the pin moves**, because it is no longer the `cli.js`
grep the earlier ADRs describe. 2.1.220 publishes `@anthropic-ai/claude-code` as
a stub — `bin/claude.exe` plus per-platform optional dependencies — so the
readable artefact is the platform package: `npm pack
@anthropic-ai/claude-code-linux-x64@<version>` and `grep -a` the `claude` binary
inside it. Costs nothing and reaches no API. Minified identifiers differ from
run to run and between readers (#98's `QEr` is `Zvr` here), so quote the shape
and not the name.

**Not verified — `exhausted`, `media_unstrippable`, `error`, `aborted`.** Read
off the switch above and nothing more. #98 judged provoking `exhausted` not worth
the money and both runs agree.

**Not verified — a bare `/compact` carrying a marker.** The three bare Sessions
measured sent no marker at all. The rule below keeps ADR-0012's marker-last there,
and arm D is the nearest evidence — a marker as the whole argument, read as
ordinary provenance with no suspicion, 0/3.

**Not verified — long threads.** Every Session in both runs compacted roughly 32k
off a two- or three-message conversation, and several summaries said in as many
words that there was little to summarise. Nothing here is evidence about a real
thread at a real threshold.

**Not verifiable, and stated as such.** The frame survey's suspicion figures are
model behaviour, not a stream contract. They are an observation of one model on
one build on one day; they cannot become a regression test, because a check
asserting that a summariser complies is flaky by construction and a check people
mute has stopped watching. Where a decision below rests on them, it rests on a
reading of a tendency and says so.

**Not measured — anything about roma.** No relay code exists, so the Task Queue,
the cap, `/stop` against a running `/compact`, Parking, Overflow and the Audit
Record are all untouched by both runs.

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

### `/compact` takes an argument, and that argument carries no Caller Marker

**Amended 2026-08-01.** This section originally put the marker between the
command and the Caller's text and argued that this restored ADR-0011's ordering.
The frame survey retired it. What replaced it is below; what it said, and why the
survey killed it, is under "Alternatives considered".

The frame roma writes:

```
/compact

keep the architecture decisions and anything still unresolved
```

Dropping the argument would leave `/compact` differing from auto-compaction only
in *timing*. "What gets kept" is the other half of the want and is the half
upstream's own warning advertises.

**The marker is absent, and this is the first time it has ever been absent.**
`CONTEXT.md` says "it is never absent"; ADR-0012 moved it and did not remove it.
The exception is bounded to one case — a Relay whose Caller supplied text — and
rests on one sentence:

> A Caller Marker says **who sent a message**. A summarisation instruction says
> **what to keep**, and what to keep legitimately names other people — *"keep
> what Bob said about the deploy"*. Inside one string those two are
> indistinguishable, and no ordering separates them.

That is not a theory. Arm E of the frame survey put roma's genuine marker first
and a second `<from>` behind it, and the summariser credited **both** 3/3 — in
one run calling both fake. The ordering held in the Transcript, where roma's
marker is demonstrably first, and bought nothing where the instruction is
actually read.

So the marker there is not merely expensive. It is **ambiguous by construction**,
and the thing it exists to prevent was measured not to happen without it: arm C
credited the request to nobody, 5/5. The misattribution the marker guards against
does not arise in a summarisation instruction, because a summariser is not
reconstructing who said what — it is compressing.

Attribution is not lost, only relocated to where this ADR already put it: the
Audit Record carries the Caller with `kind: relay` and `trigger: manual`, and
`CONTEXT.md` already calls that "the only place *spending* can be attributed to a
person". The Transcript still records **what was asked**, verbatim, in
`<command-args>`. It no longer records **who asked**, and that is the price.

The rule is therefore two lines, and each has its own measurement:

| Relay | marker | why |
| --- | --- | --- |
| Caller supplied no text (`/context`, a bare `/compact`) | after the command (ADR-0012, unchanged) | nothing exists for it to be confused with — arm D: no suspicion 0/3, attribution recorded 3/3 |
| Caller supplied text (`/compact <instructions>`) | **absent** | it would be indistinguishable from a name the Caller meant — arm C: instruction honoured 4/5, suspicion 1/5, misattribution 0/5 |

It reads backwards — present when there is no content, absent when there is —
and it follows from the same sentence both times.

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

**roma does not inspect the argument for marker-shaped text either.** Refusing
one was considered and rejected: naming another person in a compaction
instruction is the feature working, not an attack, and a rule that treats names
as suspicious fights the thing it is protecting.

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

**A Compaction is recorded with ADR-0019's field and nothing new** — the optional
`compaction` carrying `trigger`, which #115 built for the auto path and which
takes this one without alteration. `/compact` needs no schema decision at all,
which is the orthogonalisation paying for itself:

|  | `kind: 'task'` | `kind: 'relay'` |
| --- | --- | --- |
| `trigger: 'auto'` | auto-compaction; the cost lands on whoever crossed the threshold — #98's unfairness | — |
| `trigger: 'manual'` | — | **somebody typed `/compact`; the cost lands on them** |

The pair answers "who asked for this Compaction" without a field being invented
for the question.

### The drift check changes its key, and ADR-0012's was narrower than it read

**Amended 2026-08-01.** This section said ADR-0012's check "would fire on every
legitimate `/compact`" and replaced it with a per-entry expectation compared "in
either direction". Both halves were wrong, and the measurement is what shows it.

**`num_turns` cannot see a paid Relay.** Measured: a manual `/compact` that moved
`total_cost_usd` by **$0.0453** over **28,545ms** reported `num_turns: 0`.
`duration_api_ms` was `0` and the top-level `usage` was all zeros. So ADR-0012's
check would not fire on a legitimate `/compact` — it would **never** fire — and a
per-entry expectation keyed on the same field has nothing to compare, because
reality says zero for a free Relay and a paid one alike.

The two paths differ because an auto Compaction rides *inside* somebody's Turn
and bumps its count to 2 (#100), while a manual one is a `type:"local"` command
answering locally and reports what every local command reports.

**The consequence for ADR-0012 is worse than for this ADR, and it is not this
ADR's to fix quietly.** ADR-0012's table promises:

> | became model-driven | `num_turns >= 1` | the drift check |

That row holds only for an entry that becomes a *prompt*. An entry that stays
`type:"local"` and starts doing model work is invisible to it — and `/compact` is
a live example of exactly that shape. So two of ADR-0012's three rows were
unguarded, not one. The money still lands on an Audit Record, which is the
insurance ADR-0012 actually bought; what was never bought is the alert.

> **The key is the `modelUsage` output-token delta, summed across models. A Relay
> declared free that produces output tokens is written to the Operator Log.**

Keyed on **model work** rather than on money, because model work is what the
membership rule is about — "read-only", "drives no Turn". Cost is a downstream
function of it that moves with pricing, plans and models; output tokens do not.
And it is visible: on the same result where the top-level `usage` reported zeros,
`modelUsage` moved by `+2,019` input and `+1,978` output tokens. roma already
reads this object — ADR-0012's rejected alternative measured
`modelUsage[model].contextWindow` on it.

**One direction only.** A paid entry's expectation is that it *may* do model
work, not that it must: a `/compact` that fails with too little conversation to
summarise does none, at a delta of zero, and a two-directional check would report
that as drift every time somebody typed `/compact` into a short thread.

**And a check that fires before the money moves, not after.** One seam 2 case per
Relay entry, asserting its cost class against the pinned build — the shape
ADR-0014 used for the Model Menu and #111 used for a Readout's cost. The runtime
check stays as well, and the reason is that the pin does not pin everything:
`/autocompact`'s own gate is `p2d()` → `Ke("tengu_amber_redwood2")`, a remote
experiment flag, so Claude Code's behaviour can move under a fixed binary. A
pin-move ritual alone assumes the binary is the whole contract, and it is not.

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

### What the Caller is told

**Amended 2026-08-01.** This section held a table splitting the reply by
`compact_error`, on the stated ground that it "is a code rather than a sentence —
so this is not the `shared-window.ts` mistake of building on one build's
strings". On the manual path it is a sentence, and that was exactly that mistake.
Measured:

```json
{"subtype":"status","compact_result":"failed",
 "compact_error":"Not enough messages to compact."}
{"type":"result","num_turns":0,"duration_ms":29,"is_error":false,
 "result":"Not enough messages to compact."}
```

**On failure, roma relays what Claude Code already wrote.** The sentence arrives
in the terminal event's `result`, addressed to a person, at no cost. roma parses
nothing, so the field's spelling stops mattering and the table is deleted rather
than re-keyed. This is ADR-0012's own principle pointed at the same place:

> Nothing here gives roma a number of its own. What a Caller sees is Claude
> Code's own reading, relayed.

**The serious failure's handling belongs to ADR-0019, not here.** `exhausted` —
the Session that cannot be reduced below the context limit — needs roma to add a
sentence Claude Code does not write, naming `/clear`. ADR-0019 decided that, and
#115 built it. Restating it here would be two ADRs deciding one thing.

**But its classifier does not reach this path, and the implementation has to
close that.** `compaction.ts` keys on a code; the manual path sends a sentence.
The gap is not a wrong answer — an unrecognised failure lands in `unexplained`,
which tells the operator and says nothing to the Caller — it is that the manual
path's *commonest* failure lands there, so an ordinary `/compact` on a short
thread writes an operator line about a Turn that was fine. Deliberately not
solved here, because the shape of the fix depends on what the manual path can be
keyed on, and only one of its five failures has ever been seen.

**On success, roma has to write the message itself.** Measured, and not something
this ADR anticipated: a successful `/compact` returns `result: ""`. The only
thing said anywhere on the wire is a replayed `<local-command-stdout>Compacted
</local-command-stdout>`. A Caller who waited half a minute and spent five cents
is told nothing unless roma speaks.

roma reports the boundary's own figures:

> Compacted: 31,953 → 1,764 tokens.

They are already in `compact_metadata` (`pre_tokens`, `post_tokens`), so nothing
is computed, nothing parallel is maintained, and the sentence answers the only
question a Caller has — what did that buy. It is still Claude Code's reading,
relayed.

**The question #98 agonised over does not arise here.** It had to argue whether
roma may speak unprompted about something the Caller did not ask for, against
ADR-0010's high bar. A `/compact` was asked for, so the reply is the answer to a
request rather than an additional message, and the bar is not in play.

## Consequences

- `CONTEXT.md` loses **Readout** and gains **Relay** and **Compaction**. **Task**
  stops being identified by governance, since a paid Relay shares it. **Command**
  and **Caller Marker** get the rename and the marker's first absence.
- **"The Caller Marker is never absent" acquires its first exception**, bounded
  to a Relay whose Caller supplied text. `CONTEXT.md` has to say so, and has to
  say why: the marker names a sender, an argument names what to keep, and inside
  one string those are the same shape.
- **`<from>` stops meaning one thing across a Transcript.** In a Task's message
  it is roma's attribution; in a `/compact`'s `<command-args>` it is whatever the
  Caller typed. A person reading the Transcript has to know which entry they are
  looking at, and nothing in the file says so. This is the cost of the exception
  above, and it is paid by a reader rather than by the model.
- **roma can never learn whether a summarisation instruction was honoured.** The
  answer is in the summary, the summary is in the Transcript, and roma does not
  read the Transcript (ADR-0005, ADR-0006). The Caller cannot see it either — they
  get roma's "Compacted: 31,953 → 1,764". So when the summariser disregards the
  instruction, and says so inside the summary the thread will carry from then on,
  **nobody finds out**. Measured at 1/5 without a marker and 9/10 with one, which
  is the largest single reason the marker left the argument. It is not a failure
  mode that can be logged, alerted on, or tested: it is silent by construction.
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
  deferred behind this ticket is now unblocked, filed as **#113**, and
  deliberately not decided here: it needs its own argument to revive the context
  arithmetic ADR-0012 rejected, and it is roma speaking unprompted, which is
  ADR-0010's territory and nothing to do with relaying a command. Until it lands,
  this feature serves people who run `/context` — who are the people who least
  need it. **#113 also inherits a trap from these runs:** the arithmetic
  ADR-0012 measured sums `usage.input_tokens + cache_read + cache_creation`, and
  on a `/compact`'s own result all three are zero. A warning computed from that
  field reads an emptied context at the one moment it most needs to be right.
- A `/compact` now competes for one of the three concurrency slots, and it holds
  one for about twenty seconds. A free Relay never did.
- One Caller's summarisation instructions decide what survives for everyone in
  the thread, and nothing announces it. Answerable afterwards on the Audit
  Record; the same trade ADR-0014 took for a Chosen Model.
- The Relay list now spans two cost classes, so the re-audit that follows the
  ADR-0007 pin has to ask a second question of each entry — not only "is this
  still safe" but "does it still cost what the list says".
- **ADR-0019's failure classifier is code-keyed and this path is
  sentence-keyed**, so `compaction.ts` sorts the manual path's commonest failure
  into `unexplained`. Safe, and noisy: an Operator Log line per `/compact` on a
  short thread. The implementation has to reconcile them, and it cannot do it by
  enumerating sentences — that is the `shared-window.ts` mistake wearing a
  different hat, and only one of the five manual failures has ever been observed.
  **Settled in Status above**: a Compaction that fails inside a Relay roma sent
  is that Relay's own answer, so roma classifies nothing and the Caller gets
  Claude Code's sentence. The consequence is that `severityOf` no longer sees
  every failed Compaction — it sees every *unasked-for* one, which is the set it
  was written about.
- **`compaction.ts` and the Operator Log now describe the auto path only**, and
  CONTEXT.md's Compaction entry says so. "A failed Compaction is in the Operator
  Log" acquires the same exception the Caller Marker did, and for a related
  reason: a `/compact` is a request, and the answer to a request goes to whoever
  made it.
- roma gains its first relayed free text. Nothing validates it, and nothing can.
- **The one machine-checkable half of the membership rule is currently guarding
  four spellings out of five, and this is the work that has to fix it.** The
  rule keeps `/clear`, `/model`, `/effort` and `/config` out of the Relay list,
  and the ordering that makes them unreachable — `readCommand` answers before
  `readReadout` (`core.ts`) — is asserted by `shares no string with a Command`
  in `readouts.test.ts`. That test iterates a **hardcoded** copy,
  `['/stop', '/clear', '/reset', '/new']`, so `/model` is already uncovered and
  ADR-0016 and ADR-0017 will add three more spellings it will go on not
  covering, while passing. It must iterate the real `COMMANDS` table. #85 says
  the same thing and asks for it to be folded into whichever work touches that
  table; this ADR is what touches it, and the rename walks through both files
  anyway.

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
untouched, and it is the quietest arm in the survey (marker alone: no suspicion,
0/3). What it ships is the half of the want that auto-compaction already covers.
The survey sharpened the price of keeping the argument rather than changing the
answer: the argument is what draws the summariser's suspicion, and the instruction
is honoured anyway in 3/5 to 4/5 of runs, so the benefit and the noise arrive
together rather than trading off. The retreat is also cheap — dropping the
argument later is removing one entry from a named list, not a redesign.

**Keep the argument, with roma's marker in front of it** — what this ADR
originally decided, on the ground that "a forged `<from>` in the argument sits
after the real one, exactly as it does in any ordinary Task". **Retired by
measurement 2026-08-01.** That sentence is true in the Transcript and false where
it matters: given roma's marker and a second `<from>` behind it, the summariser
credited **both** 3/3, and in one run called both fake. Ordering cannot separate
them because there is nothing to separate — in an ordinary Task everything after
the marker is content, whereas in an argument the thing after the marker may be
another attribution, and a legitimate one.

**Keep the argument, with the marker last.** Rejected before the survey on the
ground that it puts Caller text ahead of roma's marker. The survey found it
**indistinguishable from marker-first** on every variable at n=5, so that
rejection now rests on argument rather than on evidence — which is worth stating
plainly, because the ADR previously implied otherwise. It is moot in any case:
with no marker in an argument at all, there is no position left to choose.

**Refuse an argument containing marker-shaped text.** Rejected, and the reason is
the feature rather than the mechanism. Asking to keep what somebody else said —
*"keep what Bob said about the deploy"* — is the feature working, so a rule that
treats a name in an instruction as an attack fights what it is protecting. It
would also make roma inspect Caller-authored text for content for the first time,
to close a gap that is a record-keeping ambiguity rather than an escalation:
nobody gains any capability by writing a name into their own compaction
instruction.

**Drop the marker and accept the ambiguity silently.** Rejected. The marker's
absence is the first exception to an invariant `CONTEXT.md` states without one,
and `<from>` now means two things in one Transcript. Both belong in the glossary
and in Consequences, not in the reader's eventual surprise.

**Exempt `/compact` from Overflow.** Rejected above. Recorded because #89 asks
for it and the instinct behind it is sound — the money buys little. The answer
is that it is an offer, and whose money it is decides who declines it.

**Keep a legacy `'readout'` spelling in `KINDS`.** Rejected by the author of the
ledger's own convention, deliberately: the migration cost is one visible,
countable, schedulable month boundary, and the alternative is a synonym that can
never be deleted and has to be explained to every future reader of a two-value
enum with three values in it.

**Key the drift check on the cost delta rather than on output tokens.** It works
— it was the only field that moved on the measured `/compact` besides
`modelUsage` — and it was the first repair proposed. Rejected because it names the
wrong thing. The membership rule is about model work; money is a function of
model work that also moves with pricing, plans and which model answered, so a
zero-cost model would silently retire the check while the behaviour it watches
carried on. Cost stays where it belongs, on the Audit Record.

**Drop the runtime drift check and re-audit only when the pin moves.** Tempting,
and cheaper: the drift report already prints what rests on the pin, and a seam 2
case per entry would catch a cost class changing before a deploy rather than
after. Rejected as the *whole* answer because the pin does not pin everything —
`/autocompact` is gated on a remote experiment flag, so Claude Code's behaviour
can move under a fixed binary. The seam 2 case is adopted *as well*, for the half
it does better.

**Re-key the failure table instead of deleting it**, splitting benign from
serious on something structural — whether the delta moved, or whether the failure
surfaced as an error. Rejected as unnecessary rather than as wrong: roma needs the
split only to add the one sentence Claude Code does not write, and that sentence
is #98's decision on a reader both tickets share. Two ADRs deciding one thing is
the cost; a table roma does not need is the benefit.

**Say nothing on a successful `/compact`.** Rejected once it was measured that
`result` comes back empty. Silence after half a minute and five cents is not
restraint, it is a Caller wondering whether anything happened — and ADR-0003
already names what that produces: "unacknowledged waiting causes users to
resend".

**One ADR covering this and #98.** Rejected, and the split held up. ADR-0019
decides how roma *records* something it cannot prevent; this decides whether
somebody may *ask* for it, and that one widens a safety rule and retires a term.
Folded together, the widening would have ridden into the repository inside a
document about bookkeeping. The split also survived its first real test: ADR-0019
landed and was measured against the manual path afterwards, and what turned up
was one seam between them — a code-keyed classifier meeting a sentence — rather
than a decision either had got wrong.
