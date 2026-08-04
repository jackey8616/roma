# 23. A Caller may press the Menu instead of typing it

Date: 2026-08-04

## Status

Accepted and implemented. `OutboundInstruction` gains a `choice` kind in
`src/channel-adapter.ts`, `Core.#answerModel` and `Core.#answerEffort` decide
which replies carry one, and `src/channels/google-chat/` renders it as buttons
and reads a press back.

Amends **ADR-0016** inline, at the Effort Matrix's list of uses, and **ADR-0017**
where it borrows a premise this ADR falsifies.

Builds on ADR-0014 and ADR-0016, which put the Model Menu and the Effort Menu
where a Caller can be told about them, and on ADR-0002, whose Overflow button is
the only thing in roma anybody could press before this.

Corrects one sentence in ADR-0014's implementation, not in ADR-0014 itself.
`src/model-menu.ts` said Claude Code's no-argument `/model` is an interactive
picker "which a Channel cannot render". That was true of the Channel roma had
when it was written and stopped being true the moment ADR-0002's offer became a
button. ADR-0017 borrowed the same line for `/config`; its conclusion survives,
on its own argument rather than on that one.

### Verification status

**Nothing in this ADR is measured, and one thing in it could be wrong.** That is
unlike ADR-0014 and ADR-0016, which rest on a pinned binary this repository
ships and can therefore read. Chat is on the other side of a network roma has no
test account for, and this repository has never captured a real Chat interaction
event — `src/channels/google-chat/chat-events.ts` says so of every reading in
it, and this adds two more held to the same standard.

**Read from Google's documentation — a press carries the card's message and the
user who pressed.** roma needs two things from a press that the Overflow button
never needed: who pressed, and which Conversation. The person is on the event;
the Conversation is derived from the card message's thread, or from the space in
a direct message.

**The claim this design would fail on.** If a press does not carry the message it
was pressed on, no Conversation Key can be derived and a press cannot become a
message. The design then falls back to a reader that returns a structured choice
and a Core entrance to receive it — which is what the Decision below rejects, and
would have to be revisited rather than patched.

**Read, and load-bearing in the other direction — a press carries roma's own
message.** The card belongs to roma, so the message on the event has an app as
its sender. `readIngressMessage` refuses anything an app said, which is what
stops two apps in one space answering each other forever. Routing a press
through that reader would either be swallowed by that guard or, with the guard
relaxed, credit the choice to roma. This is why the press gets a reader of its
own.

## Context

ADR-0014 and ADR-0016 made the Menus roma's own and made asking about them free:
`/model` and `/effort` drive no process, no Turn and no money, and their replies
read out every name a Caller may type.

What they did not do is make the offer actionable. The Menu arrives as prose in a
chat window, and the only way to act on it is to type one of its names back. On a
phone that is the slow half, and it is the half that fails: a head that misses is
not a Command at all. `/mode opus` is not in `TAKES_AN_ARGUMENT`, so it falls
through as work, `attributed()` puts the Caller Marker above it, Claude Code sees
prose rather than a command, and somebody is billed for a Turn that answers a
guess about a typo. That is precisely the fault ADR-0014 built the `/model`
Command to remove, still reachable by mistyping the head rather than the
argument.

A wrong *argument* is cheaper — `readCommand` still recognises the Command and
roma refuses the name for free — but the refusal's only remedy is *type it again,
correctly*, and it is issued at the exact moment the Caller has demonstrated they
do not know how.

Meanwhile roma had been rendering something pressable since ADR-0002.
`ChatAction` recorded the non-generalisation in as many words: *one action per
message, because roma has exactly one thing anybody can press… A second would be
a reason to revisit this, not a reason to generalise it now.* This is that
second.

## Decision

**A press is a message the Caller did not have to type. It is not a second way to
set anything.**

### Pressing is typing

A button carries the Command a Caller would have written. The Channel Adapter
reads a press into an ordinary `IngressMessage` whose text is `/model opus` or
`/effort high`, and it travels the path every typed Command travels:
`readCommand`, `#runCommand`, the same Chosen Record, the same reply.

This is the whole of the design, and everything below is a consequence of it.
Three questions that a pressable control would otherwise raise do not arise, and
they do not arise **by construction rather than by decision**:

- **Who may press it.** Anyone in the Conversation, because anyone in the
  Conversation may already type it. There is no new authority to scope, and
  ADR-0002's answer for the Overflow button did not have to be re-derived.
- **Whether a card in old scrollback goes stale.** It does not. Chat keeps a card
  clickable forever and will not re-render it, so any design where the button
  carried a decision would have that decision applied weeks late. This one
  carries a *message*: pressing a three-week-old card means send this Command
  now, which is what typing it now would mean. There is nothing to expire and
  nothing to sweep.
- **What the Adapter remembers between posting a card and its being pressed.**
  Nothing. It already remembers nothing for Overflow, for the reason given there
  — the round trip carries what is needed — and this keeps that property.

The cost is one thing and it is worth naming: the Audit Record and the Operator
Log will show a Caller having sent a message they never typed. That is accepted.
They did choose `opus`, and `/model opus` is the canonical spelling of that
intent; a record that said *pressed a button* would be a second vocabulary for
one act, and nothing reads these records to find out how a Caller's fingers
moved. Commands are not audited at all today, so this costs nothing in practice
and is recorded here for the day one of them is.

### An offer is its own kind of Outbound Instruction

```ts
| {
    readonly kind: 'choice'
    readonly text: string
    readonly chooses: Extract<Command, 'model' | 'effort'>
    readonly options: readonly string[]
    readonly refused: string | null
  }
```

Its own kind rather than an optional field on `result` and another on `failure`,
which was the smaller diff and the worse model. A `/model opsu` is not a Task
failing. It is roma declining a name, and `failure` was always the closest
available shape rather than the right one — `render.ts` renders it identically to
a `result` today, and the only thing distinguishing them was the field the text
arrives in.

`refused` is carried because the two cards answer different questions — *what is
on offer* and *the thing you asked for is not* — and an Adapter has no other way
to tell them apart. Not carrying it would leave an Adapter reading the Core's own
sentence to find out, which is the coupling `OutboundInstruction` exists to
prevent.

**The text does not change.** Every reply keeps the exact sentence the Core writes
today, and those sentences already name the whole Menu. So the buttons are purely
additive: a Channel that ignores `options` is not degraded, it is *correct*, and
that is what keeps ADR-0003's channel-agnostic Core honest without a capability
flag. A second Channel gains this feature by doing nothing.

### Two of the four replies carry one

| request | before | after |
| --- | --- | --- |
| no argument | `result` | `choice`, `refused: null` |
| a name off the Menu | `failure` | `choice`, `refused: <name>` |
| a name on the Menu | `result` | unchanged |
| `default` | `result` | unchanged |

The refusal is where a picker is worth most — the Caller has just proved they do
not know the Menu, and one press takes them from the mistake to the correction —
and it is also the one that required changing what a refusal *is*. Both halves
are deliberate.

A successful choice carries none. Somebody who just chose does not need to be
asked again, and a card under every confirmation is how a thread fills with
pickers.

### The Effort Matrix gains a third use, and it is still not a gate

ADR-0016 lists two: *it says so*, and *it records so*. It now also **shows so** —
where the Matrix reports that this Session's model takes no effort, `/effort`
emits what it emitted before this ADR and no card.

This is not the refusal ADR-0016 forbids, and the distinction is the one that ADR
turns on. `/effort max` on such a model is still accepted, still written to the
Chosen Record, still answered with the sentence saying it does not apply. Nothing
a Caller asked for is turned away. What roma declines to do is *invite* an action
it has, in the same message, just called inert — a card that said "choose one"
next to a sentence saying "choosing does nothing here" is roma arguing with
itself, and a button is a stronger invitation than a sentence is a warning.

**Suppression keys on the Matrix answering `false`, never on a falsy check.** The
Matrix answers `null` for a model it has never been read about, which is what a
deployment that pinned something off the Model Menu has, and a `null` draws the
buttons: roma has no ground to withhold an offer on the strength of a reading it
never made. `Core.#effortStranded` already states this rule as a guardrail for
the sentence; this is the same rule at a second site, and the two must agree or
roma will say a level applies while declining to offer it.

The narrower risk is named and accepted: two of the Matrix's three rows are, by
`src/effort-menu.ts`'s own admission, a person's inference rather than the
extractor's reading, and the extractor has been wrong once. If the
`claude-haiku-4-5` row is wrong, haiku Callers lose the fast path and nobody
finds out. That is a worse failure than the alternative's — drawing the buttons
always, and letting the sentence carry the correction — and it is chosen anyway,
because the sentence is what ADR-0016 already relies on for exactly this and a
button beside it undoes the sentence.

### A press gets its own reader, and `readIngressMessage` is untouched

`GoogleChatAdapter.toIngress` tries the message reader, then the press reader.
`readIngressMessage` keeps its `type !== 'MESSAGE'` guard and its bot guard
exactly as they are.

A branch inside `readIngressMessage` was the obvious shape and is the one that
breaks. The message on a press event is roma's own card, whose sender is an app,
so the bot guard would swallow it — and relaxing that guard to let it through
would re-open the fault it exists to close and attribute the choice to roma
rather than to whoever pressed. The person who pressed is elsewhere on the event,
and reading them from the message's sender is the specific mistake this
arrangement forecloses.

Three readers, each answering about one kind of event, no existing logic
modified. The Conversation Key derivation moves into one function the message
reader and the press reader share, because two readings of what a Conversation is
are two things that can drift, and a key that drifts is a Session that loses its
context.

### `ChatAction` becomes plural, and nothing else generalises

`ChatMessage` carries a list of actions rather than one, and the Overflow offer
becomes a list of one. The Chat API port renders them as a single card holding a
single `buttonList`, so a `/model` card is four buttons and an `/effort` card is
six.

**`ChannelAdapter` gains no method.** No `toAction`, no generalisation of
`toOverflowTaken`. That interface documents itself as provisional, designed
against one Channel, and says *prefer changing it then to guessing now*; a press
that arrives as an `IngressMessage` needs nothing from it, which is a third
argument for the synthesis above rather than a coincidence.

## Consequences

- The domain model gains **no term**. A pressable Menu is the Model Menu and the
  Effort Menu on a Channel that can draw them, and `CONTEXT.md` records that
  pressing means what typing means under the two entries that already exist.
  Naming the card would have put a Chat widget in a glossary that is deliberately
  free of implementation.
- **`/model opsu` is no longer a `failure`.** Anything that comes to branch on
  instruction kind to find out whether roma refused something must read `refused`
  instead. Nothing does today.
- `ENDS_THE_TASK` in the Chat Adapter is a `Set<string>`, so **the type system
  will not catch `choice` being left out of it**. It is harmless today — a
  Command has no Acknowledgement to drop — and it is added anyway, because "safe
  by reasoning" is how the next kind gets it wrong.
- **The Menus are now load-bearing for something other than prose.** A name on a
  Menu becomes a button, and a button that synthesizes a message `readCommand`
  cannot read back produces a billable Task, silently. A Menu name containing
  whitespace does exactly that; one carrying uppercase makes roma refuse a name
  it just offered. Both are caught by a structural invariant test in the idiom of
  the Command/Relay overlap check, driven over the real Menus. Both Menus already
  declare themselves a person's judgement about the pinned build and require
  re-auditing when it moves; this is the mechanism `src/effort-menu.ts` says
  "somebody remembers" stopped being.
- **A Caller can now reach a Command without the Command's spelling existing in
  the thread.** Somebody reading the transcript sees roma's reply and no `/model
  opus` above it. The reply is addressed to whoever pressed and says what changed,
  which is what a typed Command's reply says, so nothing is hidden — but the
  *question* is no longer in the record, and there is no plan to put it there.
- **`/config` is unchanged and now inconsistent.** It reports and points at
  `/model` and `/effort`, which answer with cards; it does not carry cards of its
  own. Ten buttons on one message, or a two-level card, is a design question this
  ADR does not open.
- Nothing new is registered with Chat, and that is deliberate rather than
  incidental — see below.

## Alternatives considered

**Register roma's spellings as Chat slash commands.** Rejected, and it is the
alternative most likely to be suggested again, because it is the one that
produces a real menu with no card at all: Chat renders an autocomplete when a
Caller types `/`. It would also break every Command roma has. Chat strips a
registered command from `argumentText`, and `readIngressMessage` reads
`argumentText` first, so `/model opus` would arrive as the bare text `opus`, fail
`readCommand`, and fall through to a billable Task — turning five free Commands
into paid Turns. The registration also lives in the Chat API console rather than
in this repository, where nothing versions it and no test can see it.

**A field on `result` and on `failure` instead of a new kind.** The smaller diff.
Rejected because it leaves `/model opsu` modelled as a Task failure, which it is
not, and spreads one concept across two kinds that an Adapter then has to
reassemble.

**A new `ChannelAdapter` method, `toModelChosen` or a general `toAction`.**
Rejected. It is more honest in one narrow sense — it does not describe a press as
a message somebody sent — and it costs a Core entrance, a change to a provisional
interface, and fresh answers to the three questions the synthesis makes
disappear. `toOverflowTaken` needed its own method because a Task id is not a
message; a Command *is* one.

**A dropdown rather than buttons.** Rejected on the feature's own purpose. A
`selectionInput` is two taps before anything happens, against one, and reading
what was selected means a `formInputs` path `chat-events.ts` does not have — a
third guess about a payload nobody has captured, spent to make the fast path
slower.

**Cards on every reply, or on every Task result.** Rejected. It is the only shape
that removes typing entirely, and it buries the Conversation under controls,
collides with the Overflow button's one-action-per-message, and has no answer for
which of a split answer's messages carries it.

**Drawing effort buttons on a model the Matrix says takes none.** Rejected above,
with its risk named. The competing failure — that the Matrix's haiku row is wrong
and nobody notices — is real and is the price.

**Disabling those buttons rather than omitting them.** Rejected outright, and it
is the option ADR-0016's language forbids most directly: a disabled button is a
reading of a minified binary presented to a Caller as a fact about what they may
have, which is borrowing exactly the authority that ADR declined to borrow.

**Doing nothing, on the grounds that `/model` is already free.** Rejected. Free is
not the same as easy, and the failure this addresses is not the cost of asking but
the cost of missing: a mistyped head is a paid Turn, and it is paid by everyone
sharing the window rather than by the person who typed it.
