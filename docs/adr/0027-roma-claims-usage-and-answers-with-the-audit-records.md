# 27. roma claims `/usage`, and answers with the Audit Records

Date: 2026-08-11

## Status

Accepted, and **implemented** (#165, #166). `/usage`, `/cost` and `/stats` are
Commands answered from the Audit Records by a single walk of the month —
`AuditLog.breakdownFor`, which `totalFor` is now folded from — and the Relay list
is the two entries this ADR leaves it at. Every record roma writes now names the
Runtime that served it: absent reads as Claude Code, a value roma cannot name
makes the line unreadable, and the month is split by Runtime as well as by
credential, so the report gives both registers per Runtime — two lines today. The
`Runtime` type *The Runtime goes on the Audit Record now* found nowhere in `src/`
is `src/runtime.ts`, beside the closed list of them. Nobody has yet asked whether
`/context` is Eviction-invariant, which is where the *Verification agenda* below
still stands.

Third in the family ADR-0013 and ADR-0017 began, and the one that changes what
the family is about. Both of those claimed a spelling because leaving it
unclaimed cost a Turn to answer nothing:

> a spelling roma leaves unclaimed is one somebody is billed for

That fault does not exist here. `/usage` has been relayed since ADR-0012 and is
free, non-interactive, read-only, and answered by the real command rather than
by a model's guess about it. It is claimed anyway, because it costs nothing to
answer **wrongly**, and a wrong number nobody is billed for is worse than a
right one somebody is: the bill announces itself and the number does not.

### Verification status

Two of the three load-bearing facts are measured from artifacts already in this
repository, at no cost. The third is a screenshot.

**Measured — the wire carries no quantity for the Shared Window.** Every
`rate_limit_info` in `test/fixtures/claude-stream/` carries exactly six fields:

```json
{"status":"allowed","resetsAt":1785271200,"rateLimitType":"five_hour",
 "overageStatus":"rejected","overageDisabledReason":"no_limits_configured",
 "isUsingOverage":false}
```

Three states, a reset moment, and two facts about Overflow. There is no
utilization figure, no token count, and nothing else roma is declining to read.
`src/shared-window.ts` notes that Claude Code's own renderer "ignores it
entirely below 70%", which implies a utilization figure exists **somewhere** in
that product; it is not on this wire.

**Measured — the counters behind `/usage` belong to the process.**
`src/claude-session.ts` already records it, from seam 2:

> seam 2 measured a Session that had spent $0.0822846 reporting $0.0105342 on
> its first Turn after resuming, so the total is the *process's* and there is
> nothing to carry.

`#cumulativeCostUsd` and the `modelUsage` high-water mark are differenced for
exactly this reason. What `/usage` prints is the undifferenced version of the
same numbers.

**Not measured — the exact text `/usage` returns on the pinned build.** The
witness is a screenshot of a Google Chat thread: a Session answering `$0.0000`,
`0s` of API time, `0 input, 0 output, 0 cache read, 0 cache write`, under an
Acknowledgement reading `Working…`. That acknowledgement is itself the evidence
of a cold start — `Core.#runFreeRelay` posts it only when the Session is not
resident — so the zeros are the correct output of the command against a process
one second old. Nothing below turns on the wording, only on the scope, and the
scope is measured above.

**Not measured — whether `/context` is Eviction-invariant.** The rule this ADR
adds is stated as a property that can be tested, and the only free entry left on
the Relay list has not been tested for it. See *Verification agenda*.

## Context

`/usage` looks broken and is not. It is a free Relay (`src/relays.ts`), handed to
the Session's Claude Code process as itself, and whatever it says is posted
verbatim as the Result (`Core.#runFreeRelay`). The numbers behind it are the
**process's**, and roma's processes are disposable by design: the Session Pool
evicts them to make room and reaps them when they go unused, and the next message
resumes from the Transcript.

So the reading resets whenever a process does, for reasons the person asking
cannot see and is not meant to have to.

**The zeros are the mild version.** A cold-started Session answers zero, which at
least looks wrong. A Resident Session answers a *fraction* — whatever that
process happened to serve — which looks right and is not. The failure mode with
no visible symptom is the one that lasts.

**Every check roma has passes.** The seam 2 case for the Relay list sends the
free entries "on a process that has spent nothing" and asserts only that the
reply is non-empty and is not `Unknown command` (`src/relays.live.test.ts`). The
Core's drift check watches for a free entry that starts doing model work, and
`/usage` does none. The screenshot above would turn every one of them green.

**The membership rule passes too, and that is the finding.** ADR-0018 rewrote it
to:

> a Relay changes nothing roma holds a belief about

`/usage` changes nothing. It reads. It is exactly the shape the rule was written
to admit, and it is still wrong — so the rule is describing less than it was
believed to describe. What it does not say is anything about the *answer*.

There is already a sentence in `CONTEXT.md` that decides this, filed under a
different term. **Eviction**:

> The Session survives it — the next message resumes from the transcript on disk
> — so **nothing the person using it can observe changes**.

`/usage` is a way to observe an Eviction. That is the whole of the defect, and it
was written down before the defect existed.

## The decision

**`/usage`, `/cost` and `/stats` become Commands. roma answers them from the
Audit Records, with what the deployment has spent this calendar month, and says
nothing about the Shared Window.**

### The Shared Window half is dropped, because the wire cannot answer it

The first thing a person means by `/usage` is *how much have we got left*, and on
this build that question has no answer roma could give. `rate_limit_info` carries
three states and a reset moment. It is enough to decide whether to Park a Task,
which is all `src/shared-window.ts` was ever asked to do with it, and it is not a
quantity.

Two ways to get one were considered and both are rejected:

- **Report the three states instead of a quantity.** roma would have to start
  keeping a reading it deliberately throws away. `Attempts.begins()` clears the
  last one on purpose — "a reading left behind has a `resetsAt` that has already
  passed, so a later failure carrying no reading of its own would park against a
  moment in the past and rerun instantly, for ever". Keeping a second, durable
  copy for reporting means the one thing this codebase has already been bitten
  by: two readings of the same fact, one of which is stale by construction.
  Rejected as a cost paid for a sentence rather than for a number.
- **Drive a Turn to refresh the reading.** A `rate_limit_event` arrives on every
  Turn, so this works, and it makes the command that asks about the quota spend
  the quota. Worse, it fails exactly when it is wanted: a `/usage` sent against a
  spent window is a Task, and a Task against a spent window Parks.

So `/usage` says nothing about the window. That is a smaller answer than the
question deserves and an honest one, and it is Claude Code's constraint rather
than roma's — if a later build puts a figure on that wire, this paragraph is what
should be revisited.

### The money half is two numbers, and adding them would be a lie

`AuditLog.totalFor` already sums a calendar month. Its `costUsd` folds both
credentials together, and the Overflow cap does not use it that way — it asks for
`totalFor(month, 'overflow')`, on a rule the file states plainly:

> the cap is on metered spend, and Shared Window Tasks are not spend in the sense
> it means

A Shared Window Task carries a `costUsd` because Claude Code prices every Turn.
Nobody is billed it. It is what the work would have cost on metered billing, and
under ADR-0002 the deployment pays a subscription instead. An Overflow Task's
`costUsd` is money that left an account.

So `/usage` reports them as two lines in two registers — a quantity of quota
drawn, and an amount billed — and never as a sum. roma's own code already refuses
to add them; the report it gives people should not do what the cap is forbidden
to do.

The figure is qualified where it is knowably short. `AuditTotal.unpriced` counts
Turns that began and were never priced — abandoned mid-Retry-Storm, or cut short
by a process that died — and the file names the honest reading itself: "at least
`costUsd`, over `tasks` Tasks, `unpriced` of which are not in the figure". Where
`unpriced` is zero the figure is exact and is given as such; where it is not, the
number is given as a floor. The counts themselves are not printed, because three
columns that read zero forever are three columns nobody reads.

`unreadable` and `mismatched` are different in kind and are not decorations on a
number. `unreadable` above zero means lines roma wrote and cannot read back;
`mismatched` above zero means the credential roma believed was paying is not the
one Claude Code said was — which is the failure ADR-0002 is most afraid of, and
under it the figure is describing money that came from somewhere else. Where
either is above zero the report says the total cannot be trusted, rather than
printing it with a footnote.

### It is a Command, which makes six

Nothing about this answer needs the Session's process. It is a file read.

Relaying it was never only a wrong answer; it was a wrong answer delivered
through a mechanism with three costs it did not need to pay:

- **It queues.** A free Relay is serialised against its Session, so *how much
  have we spent* waits behind whatever Turn that Session is running.
- **`/stop` cannot reach it.** `Core.#runFreeRelay` says so in as many words —
  "a gap rather than a decision". Moving the last three read-only entries off
  that path does not close the gap, but it empties it of everything except
  `/context`.
- **It does not exist on Codex.** A Relay is refused on a Codex Session
  structurally, because a Relay needs a process with something to hand a command
  to and the Codex wire has none (ADR-0025). The month's spend has nothing to do
  with which Runtime a Session runs on, so answering it through the one mechanism
  that is Claude Code's alone is backwards.

A Command has none of those. It drives no Turn, is not queued, is not counted
against the cap, and reads the same on either Runtime.

**All three spellings, and that is the existing rule rather than a new one.**
`src/commands.ts` already requires it — "Every spelling Claude Code declares for
one of these is claimed, aliases included" — and Claude Code declares `/cost` and
`/stats` as aliases of `/usage`. Leaving either behind would leave a spelling
that answers a different question from the one beside it, which is ADR-0013's
fault with the money swapped out for a number.

The Relay list is two entries afterwards: `/context`, free, and `/compact`, paid.

### `/usage` is the first Command that is not about this Session

Every other Command answers about the Conversation that sent it. `/stop` ends
this Conversation's work, `/clear` gives this Conversation a Session, `/model`
and `/effort` set this Session's, `/config` reports this Session's. `/usage`
answers about the deployment, and the same message sent in any Conversation
returns the same figures.

Named here because it is the kind of asymmetry that gets smoothed away by
somebody tidying: a later reader looking at six Commands, five of which take a
Conversation Key and one of which ignores it, should find that written down as a
decision rather than as an oversight.

It also means everyone who can message roma can see what the deployment spends.
That is not a new boundary — it is the one every Reach already has, "every
Conversation reaches all of it, and so does everyone who can message roma" — and
it is not gateable in any case: `CONTEXT.md` binds the Core to print a Caller and
never interpret one, so "nothing compares one, parses one, or decides anything by
one". A per-person answer would need that rule broken first.

### The Runtime goes on the Audit Record now, while it is trivially true

The Shared Window is one per Runtime (ADR-0025): Claude Code's and Codex's are
separate quotas on separate credentials, and `CONTEXT.md` already says "a
sentence about the window has to say whose". The Audit Record cannot say whose.
It carries a `credential` — `shared-window` or `overflow` — and nothing about the
Runtime.

Today that is harmless, because there is one Runtime and no `Runtime` type in
`src/` at all. The day Codex lands, a `/usage` written today starts adding two
separate subscriptions' notional draw into one figure, silently, and the sentence
`CONTEXT.md` forbids is the sentence roma is printing.

So the field is added now, with one value in it, and `/usage` reports a line per
Runtime — one line today. Absent means Claude Code, which is the same rule
`kind` absent means `task` already relies on for records written before Relays
existed.

Added now rather than when Codex lands, because an Audit Record is append-only
and roma never deletes one: a field added later leaves every record before it
ambiguous between "Claude Code" and "written before anybody was asking", and the
whole point of the field is to tell two Runtimes apart. It is cheapest at the
moment its answer is uninteresting.

### The membership rule gains a second clause

> **A Relay's answer must be true of the Session, not merely of the process
> serving it.**

Not a new invention. It is Eviction's promise — "nothing the person using it can
observe changes" — read as a constraint on what may be relayed, and the existing
first clause is silent about it because it is a rule about *changes* and this is a
rule about *answers*.

It partitions the current list exactly, which is the evidence it is the right
rule rather than a rule fitted to one incident:

| entry | true of | verdict |
| --- | --- | --- |
| `/context` | the Session's loaded conversation, reloaded on resume | stays |
| `/compact` | the Session's conversation, which it rewrites | stays |
| `/usage` `/cost` `/stats` | the process's counters, zeroed at every spawn | goes |

And it is stated as something a machine can be asked, which the first clause
never could be: **send it, evict, resume, send it again, and the answer should
not have moved.** That is a seam 2 case, and it is the one this ADR asks for.

### What is not closed

**Claiming the spelling forecloses relaying it later.** `readCommand` answers
before `readRelay` is consulted, so a `/usage` that is a Command head never
reaches the Relay table — the same ordering ADR-0013 relies on to keep `/clear`
out of reach, and ADR-0017 recorded as applying "whether or not it is wanted". If
a later build changed `/usage` to report the *plan's* usage rather than the
process's, that version would satisfy the new clause and would still be
unreachable. Recorded rather than fixed: roma would want to own the answer at
that point anyway, and the thing to change would be what roma's own `/usage`
says, not how it is delivered.

**`/usage foo` falls through as work.** `readCommand` refuses an argument on a
head that does not take one, and `/usage` takes none, so it is billed as prose.
This is the opening `/clear foo` has had since ADR-0013 and `/config foo bar`
since ADR-0017, and claiming a fourth spelling does not close it.

**Nobody's `/usage` is recorded any more.** A free Relay writes an Audit Record;
a Command writes nothing. So the line saying a particular Caller asked for the
month's figures goes away. Accepted rather than repaired: it is consistent with
the other five Commands, and neither log wants it — the Audit Records are the
account of the money and this spends none, and the Operator Log is what roma
decided and what surprised it, which its own definition says is not a traffic
log.

**A month is UTC, and a person in a Conversation is not.** `monthOf` slices an
ISO string, deliberately, so that a month is a fixed set of records rather than
one that depends on where the reader is standing. The report therefore names the
month it is reporting instead of saying "this month", and somebody in UTC+8 on
the first of the month will see a figure that does not match their calendar. The
alternative is a total that means something different to each reader, which is
worse for the one thing this number is for.

## Verification agenda

Ordered by how much falls if the answer is no.

1. **Is `/context` Eviction-invariant?** The new clause's only surviving free
   entry has never been tested for the property the clause asserts. Send
   `/context` on a Session with real conversation behind it, evict, resume, send
   it again. If the reading has moved materially, the clause condemns `/context`
   too and the Relay list's free half is empty — which is a much larger change
   than this ADR, and would want its own. The test needs a non-trivial context or
   it asserts `0 == 0`, so it costs a Turn or two.
2. **Does the reply survive a Channel?** The figures are short and this is the
   cheap one, but the report is the first Command output that is a small table
   rather than a sentence, and `CONTEXT.md` is firm that how a thing reads is the
   Channel's. Whatever the Core hands over has to be something an Adapter can
   render without knowing what a credential is.
3. **What does a month with `mismatched > 0` actually look like?** The refusal
   path is written above from the field's documentation rather than from a
   record, because producing one means running a Task with a stray
   `ANTHROPIC_API_KEY` present. If it is cheap to synthesise a record rather than
   earn one, synthesise it — this is the branch nobody will exercise by accident.

## Consequences

- The three spellings stop reporting a number that resets when a process does.
- `relaySpellings()` returns two entries, and the exact-list assertion in
  `src/relays.test.ts`, the no-overlap assertion between the two tables, and the
  per-entry seam 2 case in `src/relays.live.test.ts` all follow it down. The seam
  2 file iterates the real table, so it shrinks rather than silently passing.
- The Core's `free-relay-did-model-work` drift check governs `/context` alone
  afterwards. Structurally, not by omission: it is the only free entry left.
- roma's `/usage` and Claude Code's `/usage` now mean different things under one
  name — the same trade ADR-0017 made for `/config`, and made here for a
  stronger reason: the two answers are not merely different, one of them is
  wrong in this deployment.
- An Audit Record gains a field whose value is constant until Codex lands.

## Alternatives considered

**Leave it alone.** Rejected. It is the status quo and the status quo answers a
question about money with a number that is not about anything a person can see.

**Take the three spellings off the Relay list and claim nothing.** Rejected on
ADR-0013's rule, which the file states in its own comments: an unclaimed spelling
falls through to a Task, and the Caller is billed for a model's guess about what
`/usage` would have said. That is strictly worse than the defect being fixed —
wrong *and* charged for.

**Keep relaying, and post roma's figures underneath the process's.** Rejected.
It keeps a known-wrong number in front of people and makes roma's own answer look
like a second opinion on it.

**Report the deployment's month as a single summed figure.** Rejected: it prints
subscription draw as money, and it is the arithmetic roma's own Overflow cap is
built to avoid.

**Add `runtime` to the Audit Record when Codex lands.** Rejected above — the
records written in between would be permanently ambiguous, and the field exists
precisely to remove that ambiguity.

**Give `/usage` an argument** — a month, a Caller, a Session. Rejected for now.
Each is answerable from the same records and each is a separate decision about
what a shared thread may ask about other people; `TAKES_AN_ARGUMENT` has grown
from one entry to three by hand and each time deliberately, which is the check on
it, and this ADR has no argument it needs.
