# 10. The Acknowledgement does not show the answer

Date: 2026-07-30

## Status

Accepted, and **built** in the same sitting. Narrow by design: it settles what
one message says, and reverses nothing.

**Amended 2026-07-30** — one Consequence has stopped being true: the length gap
it recorded as inherited is closed (#75). The decision is unchanged. The
amendment is marked inline.

Refines ADR-0003 rather than amending it. That ADR's Progress reporting section
is unchanged and stays unchanged — what follows is the other half of the same
rule, which it never had cause to state because the collision had not been seen
yet.

## Context

A Task was reported as having been sent twice. It had not been. What the
Conversation held was two messages, seconds apart, holding nearly the same text:

- the Acknowledgement, edited in place while the Task ran, frozen at whatever
  the last throttle tick had shown — a truncated prefix of the answer
- the Result, posted whole as its own message

Both are exactly what roma is built to do, and each has a reason on the record:

- The Acknowledgement rendered the `writing` phase as the answer prose itself,
  because that is the most alive a message can look while a Turn generates.
- The Result is its own message unconditionally (ADR-0003), because it is what
  people search for, quote and reply to months later, and burying it inside a
  message that mutated for five minutes makes it hard to find.

Neither decision is wrong. Together they guarantee that every Task with a
written answer says it twice. Nobody had written down that the two rules meet,
so nothing in the code could notice.

## Decision

**The Acknowledgement gives way. The Result rule does not move.**

The `writing` phase carries how much has been written — a character count — and
never the prose. In Chat it reads `Writing… (1240 chars)`, which is the same
shape as the phase beside it, `Thinking… (~1200 tokens)`.

The count is not decoration. Progress is throttled by comparing what a Task is
doing now against what the Channel was last told, so a phase carrying no
changing value at all would compare equal to itself on every tick and leave the
Acknowledgement motionless for the whole of a generating Turn — which is
precisely what a dead Task looks like, and what the Acknowledgement exists to
rule out.

**`--include-partial-messages` remains required**, and its justification moves.
ADR-0003 established it because generation is otherwise silent, and used it to
supply prose. The prose is no longer shown; the events still are the only thing
arriving during generation, and the count is derived from them. Without the flag
the Acknowledgement freezes for the whole of a generating Turn. A future reader
who sees that roma no longer displays the deltas should not conclude the flag
can go.

## Alternatives, and why not

**Delete the Acknowledgement once the Result is posted.** Rejected on a measured
fact rather than on taste: Google Chat leaves a visible "message deleted"
tombstone where a deleted message was, so this trades a duplicate for a
gravestone. Verified by hand against a real Workspace — a reply inside a thread,
deleted, leaves the marker — and app authentication is not going to render more
cleanly than a person does. It also cannot fix the half of the complaint that
was reported from a phone: a delete does not retract a push notification that
already fired, so the two buzzes remain either way. And it would widen `ChatApi`
from the two calls it deliberately has to three.

**Edit the Acknowledgement into the final answer** — one message, one
notification, streaming preserved. This is the only option that reduces the
notifications, and it is still refused: it reverses ADR-0003's unconditional
rule outright, turns an answer longer than Chat's limit into a hybrid of one
edit and N posts, and breaks the guarantee that a Task's last instruction is its
last, which is what lets an Adapter drop an Acknowledgement the moment a Task
ends.

**Collapse the Acknowledgement into a short sentence when the Result is
posted** — the same end state as the decision above, with the streaming prose
kept while the Task runs. Genuinely close, and refused only for its cost: an
extra Channel call per Task and an Adapter that must edit a message it is
otherwise finished with. Worth reopening if anyone misses watching the answer
arrive; nothing else here would have to change for it.

**Show a fixed prefix of the answer instead of the tail.** Rejected before it
was proposed, by the code it would have reverted: the renderer showed the *end*
of the partial answer precisely because a prefix stops moving once the answer
outgrows it, which reads as a hang.

## Consequences

- The duplicate is gone, and the Result is still the only place the answer
  appears — searchable, quotable, one message per Task.
- **Two notifications remain.** The Acknowledgement is a post and the Result is
  a post; edits in between do not notify. What changed is that the first one now
  says `Working…` rather than half an answer, so they no longer read as the same
  message sent twice. Anyone who wants one notification is asking for the second
  alternative above, and that is an ADR-0003 conversation.
- The Core no longer accumulates a Turn's prose to hand to a renderer that will
  not show it — 17706 characters in the capture this was designed against, held
  for nobody.
- ~~Nothing is trimmed to Chat's limit in the Acknowledgement any more, because
  every phase is now a fixed sentence around a small number.~~ The one phase that
  can still exceed the limit is a tool named by Claude Code's own description of
  it, which is the command itself; ~~it was never trimmed before this either, so
  the gap is inherited rather than introduced.~~ Written down because a length
  budget disappearing from the code otherwise reads as a guard that was removed.

  **Amended — the gap is closed (#75).** Every phase is bounded again. Where the
  bounds sit, how many of them there are, and which end of a command goes are
  `render.ts`'s business rather than this decision's; what belongs here is only
  that the Consequence stopped being true.
- A second Channel that *can* show prose cheaply no longer gets it from
  `TaskProgress`. That is the intended trade: `channel-adapter.ts` says to expect
  the second Channel to change the interface and to prefer changing it then to
  guessing now, and carrying a whole Turn's text for a Channel that does not
  exist is the guess it warns against.
