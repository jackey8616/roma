# 12. A Readout relays a whitelisted command, marker last

Date: 2026-07-31

## Status

Accepted. Nothing implements it yet.

Corrects a claim ADR-0003 makes about Commands — that Claude Code's own slash
commands are passed through as work — without disturbing the decision that claim
sits beside. ADR-0003 decided that roma recognises `/new` and `/stop` and
prefix-matches nothing. That stands. What was wrong is the sentence explaining
why it was safe.

Takes an exception to ADR-0011's restatement of the Caller Marker rule — "roma's
part is tag-delimited and comes first" — for the four strings named below, and
for nothing else.

### Verification status

Measured on the pinned build (2.1.220, ADR-0007), in this repo's container.

**Verified — the fault.** `<from>Ada (users/17)</from>\n\n/context` drives a real
Turn: `num_turns: 1`, `total_cost_usd: 0.0549`, and the result is the model's
prose *about* `/context` rather than the command's output. Reproduced
independently through Google Chat against a running roma, which is where it was
first seen.

**Verified — the fix, on roma's own invocation.** `/context\n\n<from>…</from>`,
written as a `{type:'user'}` frame to the stdin of a process spawned with
`--input-format stream-json --output-format stream-json --verbose
--include-partial-messages --replay-user-messages --session-id`, returns
`num_turns: 0`, `total_cost_usd: 0`, and the command's real output. The marker
survives into the Transcript, as `<command-args><from>…</from></command-args>`
beside `<command-name>/context</command-name>`.

**Verified — the list.** `/context`, `/usage`, `/cost` and `/stats` each return
`num_turns: 0` and `total_cost_usd: 0`. `/cost` and `/stats` are aliases
Claude Code declares on `/usage` and they resolve to it.

**Verified — that the list fails safely when an entry is gone.**
`/skill-doctor` — which the binary carries with `supportsNonInteractive:!0` but
this build does not register — returns `Unknown command: /skill-doctor`, at
`num_turns: 0` and `total_cost_usd: 0`. A missing entry does not fall back to
being a prompt.

**Verified — that a resumed process reports the Session, not the process.**
A Turn whose `result.usage` summed to 35,225 input-side tokens was followed by
`--resume` and `/context` on a new process, which reported `35.2k / 967k` with
`Messages` at `4.6k` — against `8` on a process with no history. Resume
rehydrates, and the two independent readings agree.

**Not verified — `--permission-mode bypassPermissions`.** The stdin replication
above omits it: the flag is refused to root and the container this was measured
in runs as root, where roma's does not. It has nothing to do with how a message
is parsed, but it is a difference between what was run and what roma runs, and
naming it is cheaper than someone later discovering it.

**Not verified — any build but this one.** Every measurement here is a fact about
2.1.220. That is the whole reason the list is a list rather than a rule.

**Not verified — that the concurrency exemption below can be had without
disturbing the Task Queue.** It is a claim about code that does not exist yet.

## Context

roma has never passed a Claude Code slash command through. It has passed the
*text* of one, which is not the same thing and is worse than not passing it at
all.

| Where | What happens |
| --- | --- |
| `attribution.ts:39` | Returns `` `${OPEN}${named(…)}${CLOSE}\n\n${text}` `` — the Caller Marker, then the message. |
| `claude-session.ts:313` | That string becomes the one `{type:'text'}` block written to stdin. |
| — | Claude Code recognises a slash command only when the message begins with the slash. The frame begins with `<from>`. |

So every one of Claude Code's slash commands — `/context`, `/usage`, `/model`,
`/clear`, all of them — reaches the model as prose. The failure is silent, and
its shape is the reason this ADR exists rather than an issue: the model does not
error. It answers, plausibly, about the command it was shown, and the Turn is
billed. What a Caller sees is roma being confidently unhelpful at
`$0.0549` a go.

Two places say the opposite:

> everything else a person types is work for Claude Code, including every slash
> command Claude Code has of its own.
> — `commands.ts:9`

> Claude Code has slash commands of its own and every one of them is passed
> through as work — a prefix match would swallow commands that are not roma's,
> and would swallow more of them with every Claude Code release.
> — ADR-0003, §Commands

The decision those sentences defend is right: roma should not prefix-match, and
`/new` and `/stop` should be matched whole. The justification is not. It guards
against roma swallowing Claude Code's commands, and roma had already swallowed
every one of them, by a mechanism neither sentence was looking at.

## Decision

**Four strings are relayed to the Session's process verbatim, with the Caller
Marker written after them instead of before. One of those is a Readout.**

```
/context
/usage    /cost    /stats
```

### A Readout is what roma does, not what it costs

A Readout is a message roma hands to the Session's process as itself, rather
than as something for the model to read. Cost is not in the definition.

The alternative was to define it as "a command that drives no Turn", which is
what these four do today. That version of the word rots without anybody editing
it: it is a claim about one build's behaviour dressed as a definition, and roma
already has one of those. `shared-window.ts` says a window is spent unless the
status is `allowed`, which was true when it was written and is false on 2.1.220,
where `allowed_warning` is a third value meaning the opposite of spent. A term
defined by the provider's current behaviour is a term that becomes a lie on
somebody else's release schedule.

Defined by mechanism, "read-only and free" stops being what the word means and
becomes the *policy* for what may go on the list — revisable, and revisited
deliberately, rather than silently falsified.

### The list is a whitelist, and that is the decision

A denylist would be the cheaper thing to write and it fails in the wrong
direction. ADR-0007 pins Claude Code to one image, and pins move. Under a
denylist, a release that adds a destructive non-interactive command adds it to
roma as *permitted*, and nobody finds out until it is used. Under a whitelist,
the same release adds a command that simply does not work until somebody adds it.

The pool a denylist would have to cover is not small, and it is populated. Every
one of these is `type:"local"` with `supportsNonInteractive:!0` on the pinned
build, and every one of them would pass a rule built on "drives no Turn":

- **`/clear`** — "Start a new session with empty context". The worst of them.
  roma derives a Session id from the Conversation Key and the Session Generation
  (ADR-0003), and `/clear` moves Claude Code to a different session without
  telling roma. The next `--resume` resolves to a session roma believes in and
  Claude Code has left. `/new` exists precisely to make this move, through the
  one piece of state that records it.
- **`/model`** — the Startup Self-Check exists to prove roma is on the pinned
  model. A Chat message would move a Session off it, silently, and ADR-0002's
  account of who is paying for what goes with it.
- **`/config key=value`** — arbitrary settings, from a message.
- `/effort`, `/fast`, `/autocompact`, `/mcp`, `/import`, `/goal`, `/rename`.

The membership rule is: **read-only, non-interactive, drives no Turn, changes no
state of the Session or of Claude Code.** It is applied by a person, and it is
re-applied when the pin moves.

That last sentence is the weak point and is stated rather than hidden. Nothing in
the stream marks a command as read-only; the judgement comes from reading its
description. Two of the three ways this can go wrong are caught by machine:

| The entry | What happens | What catches it |
| --- | --- | --- |
| is gone | `Unknown command: /x`, free | itself — visible and costs nothing |
| became model-driven | `num_turns >= 1` | the drift check below |
| is still free, but now destructive | relayed as always | **only the re-audit** |

The third row is the residual risk of this decision. It is accepted because the
alternative — a rule a machine can check — is `num_turns === 0`, and `/clear`
and `/model` both satisfy that.

### The marker goes last, and only here

The message roma writes is the command, a blank line, then the Caller Marker.

ADR-0011 restated the marker rule as "roma's part is tag-delimited and comes
first". A Readout takes an exception to the second half, and can, for a reason
specific to what a Readout is: **the whole message must be exactly one of the
four strings, so the Caller contributed no text at all.** The rule exists because
what follows the marker is something a person typed, and anybody can type a line
that looks like a marker. Here nothing follows and nothing was typed. There is no
forgery surface to protect, because there is no user content in the message.

Attribution is not traded away for this. The marker is carried into the
Transcript verbatim, as the command's `<command-args>`, and the Transcript is the
only account there is of what an agent did (ADR-0005, ADR-0006). What changes is
where the marker sits in the frame, not whether it is recorded.

Every message that is not a Readout keeps the marker first, unchanged.

### A Readout is serialised, and exempt from the cap of three

Serialisation is not a choice here. ADR-0003:

> Messages within one session are **serialised**. This is forced, not chosen: two
> processes writing the same session file corrupt it.

A Readout needs the Session's process, so it queues behind that Session's work
like anything else. This has a cost worth naming plainly: **the moment a Caller
most wants to ask how full the context is, is the moment a long Task is running,
and that is exactly when the answer is furthest away.** The answer will be
correct and it will describe the world after the Task it queued behind.

The global cap of three is a different question and gets the opposite answer.
ADR-0003 argues that cap entirely in terms of model work — retry storms holding a
slot for three minutes, a bad credential reaching "bot halted" on its own. A
Readout is none of it: no Turn, no money, no retry. And the ceiling on live
processes is not that cap in the first place — `session-pool.ts` holds
`MAX_RESIDENT = 10` with LRU eviction, which bounds processes whatever this
decision says. Exempting Readouts cannot multiply processes.

Three people asking what is going on should not be able to stop the work they
are asking about.

### A Readout is audited, and its cost is recorded rather than assumed

One Audit Record per Readout, carrying whatever cost actually came back, with a
field distinguishing it from a Task.

The tempting alternative was no record: an Audit Record exists to attribute money
(CONTEXT.md), a Readout costs nothing, and "One per Task" stays literally true if
a Readout — which is not a Task — gets none. That reasoning bakes the whitelist's
assumption into the ledger, which is the one place that has to survive the
assumption being wrong. On the day an entry quietly becomes a model Turn, the
money would land nowhere at all.

`audit-log.ts` already refuses this exact trade in the other direction:

> a Turn that began and never reached a terminal event spent real tokens nothing
> will ever name, and that is written down as unpriced rather than as free.

Recording a cost roma expects to be zero, instead of recording nothing because it
ought to be zero, is the same discipline pointed the same way.

The field is optional, and a record without it reads as a Task. `readRecord`
drops a line it cannot parse and a dropped line leaves the month's total, which
is what the Overflow cap is enforced on — so a required field would silently
reset the month across the deploy that added it. This is the reasoning
`callerName` already carries, for the same reason.

### The drift check

A Readout that returns `num_turns !== 0` is written to the Operator Log.

That is an anomaly rather than traffic, which is what the Operator Log is for —
"an Eviction, a Reaping, a credential swap, a refusal". A Readout that behaves is
not logged there; logging every one would make it a traffic log, which its own
definition rejects. What this catches is the pin having moved under roma and an
entry on the list having become something that spends money.

### An Acknowledgement only when the Readout cannot run at once

Sent when the Session is busy or has no resident process. Not sent otherwise.

Unconditional is wrong on the common path: a Readout on a warm Session returns in
milliseconds, so the Acknowledgement would appear and be superseded in the same
breath — two messages for one event, which is the whole of what ADR-0010 argued
against. Never is wrong on the other path: ADR-0003's own case for the
concurrency cap says "unacknowledged waiting causes users to resend, which
compounds the backlog", and a Readout behind a five-minute Task is exactly that
silence.

This is roma's first conditional rule of this kind, and the Caller Marker's
"unconditionally, DMs included" is a warning about the class. The condition here
is computable at the moment of asking — is this Session resident, and is it idle
— rather than remembered, so it cannot be lost across a restart the way the
marker's rejected alternative could.

## Consequences

- The domain model gains a third kind of inbound message. A Readout is not a
  Command — it needs a process, so it queues — and not a Task — it drives no
  Turn. CONTEXT.md gains the term.
- ADR-0011's "roma's part is tag-delimited and comes first" acquires its first
  exception, bounded to four exact strings.
- roma now has a list that must be re-audited whenever the ADR-0007 pin moves.
  Nothing enforces that; the drift check catches two of the three ways it can be
  wrong, and the third is the risk named above.
- A Readout on a non-resident Session can evict somebody else's at
  `MAX_RESIDENT`. That third party pays a cold start for a question they did not
  ask and will not be told why. The Operator Log makes it traceable but not
  attributed: `spawn` (with `residents`) and `evict` land adjacently.
- `AuditRecord` gains an optional member, and `totalFor` has to decide whether
  its `tasks` count includes Readouts. If it does, "how many Tasks did Ada run"
  quietly becomes "how many messages did Ada send".
- A Readout leaves nothing in the Operator Log on the happy path and, on a warm
  Session, causes no `spawn` or `evict` either. Its only trace is the Audit
  Record.
- `/context` output is mostly Markdown tables, and Google Chat is not a Markdown
  renderer. `render.ts` splits at `MAX_TEXT = 4096` rather than truncating, so a
  long one arrives whole across several messages. How it *reads* is the Channel's
  problem and is not solved here.
- Nothing here gives roma a number of its own. What a Caller sees is Claude
  Code's own reading, relayed.

## Alternatives considered

**Let roma compute it and answer as a Command.** Rejected, though it is the only
option that is instant and works while a Session is busy. roma already receives
everything needed: `result.usage.input_tokens + cache_read_input_tokens +
cache_creation_input_tokens` against `modelUsage[model].contextWindow`, and the
sum was measured agreeing with `/context`'s own figure — 35,225 against a
reported `35.2k`. What it buys is a second number for the same question,
maintained by roma, free to drift from the first, and unable to reproduce the
category breakdown that makes `/context` worth reading. It also answers only
`/context`; `/usage` has no equivalent roma can compute. The one number roma
should not be keeping a parallel copy of is the one Claude Code publishes.

**Drop the Caller Marker for any message beginning with a slash.** Rejected. The
set of messages beginning with a slash is chosen by whoever is typing, so this
hands an unmarked message into the Transcript to anybody who wants one, and
`attribution.ts` is explicit that an unmarked message reads as the same person
again. The whitelist is what makes marker-last safe: exact whole-message match
means the Caller supplies no content at all.

**A denylist instead.** Rejected above, on which way it fails when the pin moves.

**Relay everything, as today.** Rejected: it is the fault, not a design. It is
worth recording that it is also not free — the status quo bills a model Turn for
every slash command anybody types.

**Let the Readout drive a Turn where the local command cannot answer.** Not
rejected so much as never needed: all four entries answer locally. Recorded
because it is the obvious next question when somebody wants a fifth entry that
does not, and the answer should be that such a command is a Task and always was.

**Give Readouts no Audit Record.** Rejected above. The record is insurance
against the whitelist being wrong, which is the one failure mode this design
cannot rule out.
