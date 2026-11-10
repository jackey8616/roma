# 40. A reply says when the context is nearly full, in Claude Code's words

Date: 2026-11-10

## Status

Accepted, and **implemented**. Closes #113. Narrows ADR-0012's rejected
alternative rather than reversing it, and builds on ADR-0018 (`/compact` exists,
so there is something to recommend) and ADR-0019 (which recorded this as the
missing half).

### Verification status

**Read off the pinned build (2.1.220, ADR-0007), free** — `npm pack
@anthropic-ai/claude-code-linux-x64@2.1.220` and `strings` the binary, as
`docs/manual-compaction-verification.md` does:

- `/context` builds its own suggestions, and one of them is this, verbatim:

  ```js
  if (e.percentage >= esf) t.push({severity:"warning",
    title:`Context is ${e.percentage}% full`,
    detail: e.isAutoCompactEnabled
      ? "Autocompact will trigger soon, which discards older messages. Use /compact now to control what gets kept."
      : …})
  // esf=80, percentage: Math.round(totalTokens/rawMaxTokens*100)
  ```

  That is the sentence #98 quoted, and 80 is the threshold Claude Code itself
  chose for saying it.

- **When auto-compaction really fires cannot be reproduced.** The trigger is the
  effective window minus 13,000, but the effective window comes from `o7()`, which
  may cap the model's window from a server-side value or a remote flag
  (`tengu_amber_moleskin`) and not from anything in the binary. A pin does not
  pin it.

**Measured, off captures roma already holds:**

- **`result.usage` is summed over every API call in a Turn.** The first Turn of
  `tool-use-turn.jsonl` made three calls holding about 32k each, and its
  `result.usage` reports 93,655 cache-read tokens. ADR-0012's 35,225-against-`35.2k`
  agreement was a one-call Turn, where a sum of one is the figure. On any Turn that
  used a tool the same arithmetic overstates the context by the number of calls.
  The figure that tracks the context is the **last** assistant message's `usage`.
  Enforced by `fence:stream-context-held-is-the-last-call`.

**Not measured:** a real Session near 80% of a real window. Nothing here has
filled a 1M context.

## Context

roma could see a Session's context filling and said nothing until Claude Code
compacted it — after which the context is already gone, and ADR-0019 decided
there is nothing to say. ADR-0018 records why that matters: *"`/compact` alone is a
button nobody presses at the right moment."* A Caller does not watch a context
fill, so `/compact` served only the people who run `/context`.

#113 asked six questions before anything was built. They are answered in order.

## Decision

### 1. roma does not keep a parallel figure; it repeats a recommendation

ADR-0012 refused to have roma answer `/context` with its own number: a second
number for the same question, free to drift. That still stands — roma does not
show the figure anywhere and does not answer `/context`.

What roma does is narrower: when the pinned build's own `/context` would say
*"Context is N% full … Use /compact now"*, roma says it on Claude Code's behalf,
in Claude Code's words, at Claude Code's threshold. The judgement — when to warn,
what to recommend — is Claude Code's. roma computes only the one fraction
`/context` computes, from the last API call's `input + cache_read +
cache_creation` against `modelUsage[model].contextWindow`.

Drift fails in one known direction. If the server caps the auto-compact window
below 80% of the model's window, auto-compaction fires first and the warning
arrives late or never. That is today's behaviour, not a new failure, and the
warning never claims more than `/context` would.

### 2. It is not a message of its own

ADR-0010's bar is for another message in a Conversation, and every other message
roma posts answers something somebody sent. So the warning is a **paragraph
appended to the reply** of the Task that crossed the threshold — the `result`
Outbound Instruction carries `contextPercent`, and each Channel renders it after
the answer. No message is added. Enforced by `fence:core-nearly-full-in-the-reply`.
Enforced by `fence:gchat-nearly-full-in-the-reply`. Enforced by
`fence:discord-nearly-full-in-the-reply`.

The Acknowledgement was the alternative #113 suggested pricing first. It is
rejected because it is a progress surface: it is overwritten while the Task runs,
and the fraction is only known once the last call has answered — the moment the
Acknowledgement stops mattering.

### 3. It addresses the thread, not a person

The sentence is about the context ("Context is 85% full"), not about who filled it,
so it is fair to whoever's reply it lands on. It names the remedy anybody in the
Conversation can type.

### 4. Once per fill

A context near the threshold stays near it. The warning is given **once**, then
not again until a Compaction — automatic or `/compact` — has happened in that
Session, after which the context is small and filling it again is news. `/clear`
starts a new Session Generation and so starts fresh. Enforced by
`fence:core-nearly-full-once-per-fill`.

### 5. At 80% of the model's context window

Claude Code's own number (above). Not "percent compactable": roughly 26.6k of a
fresh context is system prompt and tools that no Compaction removes, but on a
200k or 1M window that is a rounding error at 80%, and Claude Code does not make
the distinction either. Enforced by `fence:context-fill-threshold-is-claude-codes`.
Re-read when the ADR-0007 pin moves, like the Relay list.

### 6. It survives an Eviction

Whether the warning was given is a record in the Work Root,
`<sessionId>.context-warned`, beside `.opened`. A restart, an Eviction or a
Reaping does not forget it. Enforced by
`fence:core-nearly-full-survives-eviction`.

Two rules about when that record changes, both found in review:

- **It is written only after the reply carrying the warning is delivered.** If it
  were written first, a reply the Channel failed to post would count as a warning
  given, and the next Task would stay silent. While a warning is on its way, an
  in-process set stops a second Task in the same Session from giving it again.
  Enforced by `fence:core-nearly-full-remembered-after-delivery`.
- **It is removed the moment a `compact_boundary` is read**, not when the Task
  ends. A Task that compacts and then waits on the Shared Window can be cut off by
  a restart, and a reset that waited for the Task to end would be lost. Enforced
  by `fence:core-nearly-full-reset-on-the-boundary`.
- **A warning belongs to the fill it was given in.** Each Session keeps an
  in-process count of Compactions. A warning still being posted when a Compaction
  lands is not written back once its post finishes, so it cannot silence the
  warning for the next fill. Enforced by `fence:core-nearly-full-belongs-to-its-fill`.

A Relay never carries the warning: `/compact` is the remedy, and a free Relay's
reply is Claude Code's own.

## Consequences

- `/compact` now gets mentioned at the moment it is worth pressing, in the reply
  that crossed the line, without a new message.
- roma reads the last assistant message's `usage` and `modelUsage[…].contextWindow`
  — one more pair of shapes on the ADR-0007 re-audit list.
- The warning can be late on a model whose auto-compact window the server caps. It
  is never early and never says anything `/context` would not.
- The record is one more small file per Session. Like `.opened`, nothing removes
  it when a Work Dir is reaped.

## Alternatives considered

**Do nothing.** Rejected: it accepts ADR-0018's discount, which is the reason
this was filed.

**Say it in the Acknowledgement.** Rejected above: the fraction is known when the
Acknowledgement is finished being useful.

**Say it only in the reply to `/context`.** Rejected: it reaches only people who
already look.

**Compute Claude Code's real auto-compact threshold.** Rejected: its window can
come from a server value roma cannot read, and a copied formula that silently
drifts is what ADR-0012 refused.

**Read `result.usage`, as ADR-0012 measured.** Rejected: it is a per-Turn sum,
measured above as three times too large on a three-call Turn.

**Keep the warned flag in the process.** Rejected: an Eviction would forget it and
re-warn at a moment the person cannot see a reason for.
