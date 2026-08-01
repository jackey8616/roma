# 19. A Compaction is a cost fact, and a failed one is an operational event

Date: 2026-08-01

## Status

Accepted and implemented, which is the order #98 asked for: the ADR comes
**after** the measurement rather than before it, because if the event had not
reached roma's stdout the failure half of this design would have had no signal
and its shape would have changed. `src/stream-events.ts` reads the two events,
`src/compaction.ts` is the whole judgement about a failure code, the Audit
Record's `compaction` field is in `src/audit-log.ts`, and `Core.#compactionFailed`
is what decides who is told.

Depends on #100's measurement (`docs/compaction-verification.md`), which cost
$0.85 and settled the one question that could have made this unbuildable.

**ADR-0018 was accepted ahead of this and depends on it.** That ADR decided a
Caller may ask for a Compaction, and said explicitly that `/compact` needs no
schema decision of its own because this field would carry it. This is that field.
Nothing here implements `/compact`; what it does is make the value `trigger:
"manual"` meaningful before there is anything to produce one.

### Verification status

**Measured, on the pinned build (2.1.220, ADR-0007)** — all of it #100's:

- A Compaction announces itself on roma's stdout as `system/compact_boundary`.
  This was the open question, and everything below rests on the answer.
- Its payload is **snake_case** — `compact_metadata` — and not the
  `compactMetadata` #98 was written against, which is Claude Code's *transcript*
  spelling. A reader written from the issue body finds `undefined` and reports
  every Compaction as no Compaction, while looking like it works. This is the
  entire reason the measurement came first.
- `trigger` is `enum(["manual","auto"])`. Only `auto` has been seen.
- A Turn carrying one cost **4.9×** the same Turn without one — $0.0917 against
  $0.0186 on byte-identical messages in one Session — and took **12×** the wall
  clock, 19,487ms of it the Compaction's own `duration_ms`.
- A **failed** Compaction is not a `compact_boundary` at all. It arrives on
  `system/status`, the event that also carries ordinary progress, marked only by
  `compact_result: "failed"`, with `compact_error` carrying a **code**.
- The failure that was measured, `too_few_groups`, is **benign**: the Turn around
  it stayed healthy, cost two cents and answered, and the Session served the next
  Turn normally. It happened twice, in both captures.

**Read off the bundle, on the pinned build** — #98's second comment, quoting the
switch that maps every code to what Claude Code does with it:

```js
switch (p.reason) {
  case "too_few_groups":     throw Error(Chr);
  case "aborted":            throw Error(EV);
  case "exhausted":          throw new V7("Compaction failed · conversation could not be reduced below the context limit");
  case "media_unstrippable": throw new V7("Compaction failed · attached media exceeds size limits");
  case "error":              throw new V7(`Error during compaction: ${p.detail || "unknown error"}`)
}
```

**Not measured — `exhausted` and `media_unstrippable`, in any respect.**
Provoking either means filling a real context, which is the expensive path the
whole measurement was designed to avoid, and the reward would be confirming an
explicit `case`. That the auto path puts these codes on `compact_error` with
those spellings is read rather than measured; what *is* measured is that a code
survives the trip to stdout unchanged, which is what `too_few_groups` did. The
design below is built so that being wrong about a spelling costs an Operator Log
line and nothing else — see `unexplained`.

**Not measured — real thresholds.** Both captures were taken with the
auto-compact threshold shrunk to a few percent, with
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. A Compaction at a shrunk threshold is a
Compaction, and it answers the question this ADR asked; it says nothing about
when a real one fires, how long a full-size one takes, or what it preserves.

## Context

Auto-compaction is **on by default** on the pinned build — `autoCompactEnabled:!0`
in the default settings object — so a long-running Session compacts itself when
its context fills. Until this, nothing in roma knew that happened, and three
things followed that nobody had written down.

**It costs money, and the money lands on the wrong person.** A Compaction happens
*inside* a Turn, so its cost folds into that Turn's `total_cost_usd` delta and
therefore into that Task's Audit Record. A Conversation is many people sharing
one Session, so whoever happened to send the message that crossed the threshold
pays for compacting a context the whole thread filled. That is the exact question
the Audit Record exists to answer, and it was being answered wrongly with no way
to tell — a 4.9× outlier sitting in the ledger looking like an ordinary Task
somebody asked an expensive question.

**It discards older messages,** in Claude Code's own words, and nobody was told.

**It can fail,** and one way of failing means a Session that cannot be reduced
below the context limit — which will not serve another Turn. Every subsequent
message to that Conversation fails, roma has a repair (a new Session Generation,
which `/clear` hands out), and neither roma nor the Caller knew to reach for it.

## Decision

### A successful Compaction goes on the Audit Record and nowhere else

**It is a cost fact, not an operational event.**

The line that decides this is the repo's own. The Operator Log records what roma
*decided* — an Eviction, a Reaping, a credential swap, a refusal — and explicitly
not what an agent did. The apparent counter-example proves the rule: `retry-storm`
is in there, and retrying is Claude Code's behaviour, but what is recorded is
*roma abandoning the Task*, which is roma's decision prompted by upstream. A
successful Compaction prompts no decision at all. roma cannot prevent it, delay
it, or react to it.

What it does change is what the Audit Record says, because a Task that compacted
costs several times what the same Task otherwise would and nothing else explains
why. ADR-0012 made this exact trade in the other direction for Readouts:
"Recording a cost roma expects to be zero, instead of recording nothing because
it ought to be zero."

**The field is optional, and absent means no Compaction.** `readRecord` drops a
line it cannot parse, a dropped line leaves the month's total, and the month's
total is what the Overflow cap is enforced against — so a required field would
silently reset the month across the deploy that adds it. That is `callerName`'s
reasoning, and it is now the ledger's convention rather than one field's
argument.

**It carries `trigger`, and `(kind, trigger)` is what answers "who asked".**
ADR-0018's table, reproduced because it is the whole justification for the field
having any content at all:

|  | `kind: 'task'` | `kind: 'relay'` |
| --- | --- | --- |
| `trigger: 'auto'` | auto-compaction; the cost lands on whoever crossed the threshold — this ADR's unfairness | — |
| `trigger: 'manual'` | — | somebody typed `/compact`; the cost lands on them |

**It carries `pre_tokens` and `post_tokens`, and deliberately not
`cumulative_dropped_tokens`.** The first two are this Compaction's own figures
and say how much context the money bought. The third is cumulative for the
process the way `total_cost_usd` is, so a Task recording it would file every
Compaction the Session has ever had under itself — the same bug the `costUsd`
delta exists to avoid, one field over.

**It is filed under the credential that paid for it,** on the Attempt rather than
on the Task. A Task blocked on the Shared Window and rerun on Overflow produces
two records; summed, the metered one would report a Compaction the subscription
had already paid for.

### The Caller is not told about one that worked

After the fact there is nothing to do with the news — the context is already gone
— and ADR-0010 sets a high bar for another message in a Conversation. A warning
*before* it happens is a different matter and is #113's; it needs its own
argument, because it revives the context arithmetic ADR-0012 rejected and it is
roma speaking unprompted.

### A failed Compaction is judged by its code, in three answers and not two

#98 was written with two: `too_few_groups` gets nothing, everything else is a
Session that cannot serve another Turn. The measurement contradicted the second
half, and #98's own amendment is what this implements. Built as originally
specified, roma would have written an Operator Log line and told a Caller **"this
thread is full, use `/clear`"** during a Turn that cost two cents and worked —
a false alarm on the one channel ADR-0010 sets a high bar for.

| answer | codes | Operator Log | the Caller |
| --- | --- | --- | --- |
| `benign` | `too_few_groups`, `aborted` | no | no |
| `unreducible` | `exhausted`, `media_unstrippable` | **yes** | **yes** |
| `unexplained` | `error`, and anything roma has not seen | **yes** | no |

**Three rather than two, because roma is told a code and not a consequence**, and
its two possible responses have different bars. Telling an operator costs a line
in a stream they read when something looks wrong. Telling a Caller their thread
is full and to throw it away is a sentence roma has to be able to stand behind,
in a Conversation ADR-0010 protects from extra messages. A code roma has never
seen earns the first and not the second.

**The list enumerated is the benign one, and everything else falls outward.**
This is `shared-window.ts`'s lesson applied deliberately: that file read "anything
that is not `allowed` is spent", chosen as the shape that survives being wrong,
and it did not survive — the value it had not seen was `allowed_warning`, which
means the window is *nearly* spent and still serving. The failure mode to avoid
is a new value being folded into the answer that means "nothing to see". So the
codes roma has a positive reason to believe are harmless are written down, and a
code a later release adds lands in `unexplained`: the operator sees it, nobody is
told a wrong story about their thread, and somebody decides which list it belongs
on.

**Matching on the error *text* is refused, and costs nothing to refuse.** #98
rejected it as the mistake `shared-window.ts` already made once — defining
behaviour by one build's strings. `compact_error` turns out to be a code, so the
rejection is free.

**There is a second discriminator roma cannot use, and it is worth recording
exactly.** In the switch above, `too_few_groups` and `aborted` throw a plain
`Error`; the other three — `exhausted`, `media_unstrippable` **and `error`** —
throw the class Claude Code reserves for what it shows a user. So the build's own
line falls in the same place as the `benign` boundary above, which is why that
boundary is believed rather than guessed.

It does **not** fall in the same place as the `unreducible` boundary, and that is
the difference the third answer exists for. The build groups `error` with the
serious two; roma does not, because the build is deciding whether to show a user
a message and roma is deciding whether to tell somebody their Session is
finished, and `error` is a catch-all that says nothing about that. Only the code
reaches stdout in any case, so roma has to enumerate either way.

### roma does not clear it, and says `/clear` instead

Rejected on ADR-0002's precedent: Overflow is *offered* per-Task at the moment of
blocking rather than taken on somebody's behalf. Auto-clearing is roma deciding to
discard a person's context unbidden, and `/clear` is defined as something a
person says.

Telling the Caller at all is the part worth arguing for. They are the one
watching Tasks fail, roma is the one that knows the remedy, and the remedy is a
Command they can type. **This is one of very few places where roma knows an exit
the person cannot guess, and staying silent wastes it.**

The instruction is `context-full`, and it is **not an ending**: it arrives
mid-Task the way `blocked` does, and the Task goes on to whatever ending it has.
It carries nothing — there is one fact and one remedy, and neither the code nor
how full the context got is something the person can act on.

### Auto-compaction stays on, and that is now a decision

`function JI(){ if (Z.DISABLE_COMPACT) return false;
if (Yt(process.env.DISABLE_AUTO_COMPACT)) return false;
return Hc("autoCompactEnabled", true).value }`

`DISABLE_AUTO_COMPACT` is an environment variable, and `buildEnv` owns the
environment every Session is spawned with. So roma **can** turn auto-compaction
off, has never done so, and until this was read did not know the switch existed.

It stays on. Discarding context is bad and failing every Turn once a context
fills is worse, and this ADR's whole failure path exists because the second one
is the thing to be afraid of. What changes is that leaving it on is written down
as a decision roma is making rather than a condition roma is subject to — which
is the distinction `CONTEXT.md`'s **Compaction** entry now carries, and the reason
it is stated here rather than left implicit in an unset variable.

## Consequences

- The Audit Record answers, for the first time, why one Task cost five times what
  its neighbours did. Nothing else can: the provider knows only that somebody
  spent the shared token.
- **A Session that cannot serve another Turn now says so.** Before this, that
  Conversation failed every message with a generic reason and nobody had cause
  to try `/clear`.
- roma reads two more events off a stream that is not its own, so the ADR-0007
  re-audit gains two shapes to check and `src/compaction.ts` gains a code list a
  person maintains. It is on the same footing as the Relay list and the Model
  Menu, and it fails the same way round: an unrecognised code is reported, never
  silently accepted.
- **`trigger: "manual"` is unreachable until ADR-0018 is implemented.** The field
  carries a value nothing can currently produce. That is deliberate — it is what
  lets `/compact` land without a schema change — and it means the `manual` half of
  this is untested against a real stream, exactly as ADR-0018 records.
- `unexplained` is a category that should be empty in practice, and an operator
  seeing entries in it is the signal that the pin has moved under this file.
- **Nothing here warns anybody before a Compaction happens.** #113 is that, and
  until it lands the people best served by this are the ones reading their Audit
  Records afterwards.

## Alternatives considered

**Put a successful Compaction in the Operator Log too.** Rejected on the Operator
Log's own definition: it records what roma decided, and roma decides nothing
here. A line per Compaction would make it a traffic log, and nothing would be
totalled from it anyway — the money is the Audit Records'.

**Tell the Caller about every failed Compaction.** Rejected by the measurement.
`too_few_groups` was benign in both captures, and on the manual path it is likely
to be the most common failure there is, since somebody typing `/compact` into a
short thread is exactly "not enough conversation to summarise".

**Treat any failed Compaction as a dead Session — #98 as written.** Rejected for
the same reason, and recorded separately because it is the decision this ADR
overturns rather than a road not taken.

**Enumerate the serious codes and treat the rest as benign.** Rejected: that is
`shared-window.ts`'s shape, and its failure mode is silence on the release that
adds a code. The reverse is noisier and the noise lands on an operator rather
than on a Conversation.

**Record `cumulative_dropped_tokens` as well.** Rejected. It is a process-lifetime
figure on a per-Task record, which is the cumulative-total bug wearing a
different hat.

**A boolean instead of a field with a trigger in it.** Rejected. It would answer
"did this cost extra" and not "did anybody choose it", and ADR-0018 would then
need a schema decision of its own for `/compact` — which is precisely what
orthogonalising the two questions was supposed to avoid.

**Turn auto-compaction off with `DISABLE_AUTO_COMPACT`.** Rejected, and recorded
because roma now knows it can. It trades a cost surprise for an outage: every
Turn fails once the context fills, and the Caller has no warning at all.

**A `PreCompact` hook.** #98's fallback if the event had not been on stdout. Not
needed — it is, measured — and it would have meant roma adopting a Claude Code
config surface it does not use and running a subprocess to learn one fact.
