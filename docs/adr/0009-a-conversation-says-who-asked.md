# 9. A Conversation says who asked

Date: 2026-07-30

## Status

Accepted. Closes #66.

Supersedes the **Caller identity** section of ADR-0004, which recorded the
Caller as existing for the Audit Record alone. It does not overturn ADR-0003's
channel-agnostic Core: what changes is that the Core carries and prints the
Caller, not that it knows anything about the Channel the Caller came from.

Amends ADR-0008's `Requested-by:` trailer, which specifies an address roma
cannot obtain. The trailer itself remains unimplemented and in ADR-0008.

## Context

ADR-0004 made a Chat thread one Conversation, and ADR-0008 restated the
consequence plainly: *a Chat space is many people sharing one Conversation and
therefore one Session, so the asker changes between Turns of one process.*

roma read who sent each message and then discarded it everywhere except one line
on disk:

| Stage | Did it know who asked? |
| --- | --- |
| Chat event | Yes — `message.sender.name`. `sender.displayName` was in the payload and was never read. |
| Ingress Message | Yes — passed through as `caller`. |
| Conversation / Session | No, and by design: the Conversation Key is the thread. |
| The text Claude Code was given | **No.** `message.text` and nothing else. |
| The reply | **No.** Posted into the thread, addressed to nobody. |
| Audit Record | Yes, as an opaque `users/17`. |

So Ada and Bob each asking one thing in one thread was, to Claude Code, one
person saying two things in a row. An agent asked to do what somebody said an
hour ago had no way to tell whose "somebody" it was, and the Transcript — the
only account there is of what an agent did, and one ADR-0006 says roma never
deletes — recorded a thread as a single unbroken voice. Meanwhile two
acknowledgements could sit in one thread mutating for minutes with nothing to
say which belonged to whom.

`channel-adapter.ts` stated the position this ADR withdraws:

> Opaque to the Core, which never interprets it — it exists so the audit record
> can say who asked.

## Decision

**The Caller travels the whole way: into the Session, back out to the Adapter,
and onto the Audit Record.**

### The Caller is two fields, side by side

`IngressMessage` keeps `caller` — the Channel's own resource name, `users/17` —
and gains `callerName: string | null`, read from `sender.displayName`. Required
rather than optional, so a Channel with no name for somebody says so instead of
forgetting to.

**Not one restructured field.** `readRecord` rejects a line whose `caller` is not
a string, and a rejected line drops out of the month's total — which is the
figure the Overflow cap is enforced against. Turning `caller` into an object
would have made every record written before this change unreadable at once,
silently resetting the month and letting the cap through. On the Audit Record
`callerName` is therefore *optional*, and its three states mean three different
things: a name, `null` where the Channel had none, and absent where the record
predates this ADR.

### Every Turn is marked, in the Core

Claude Code is given the message with a line above it:

```
<from>Ada (users/17)</from>

fix the CI
```

**Unconditionally, DMs included.** Marking only when the Caller changes needs the
Core to remember who spoke last; that memory is lost on a restart, and an
unmarked message is read as "the same person again", so Bob's request would be
quietly filed under Ada in a record nobody deletes. A DM exemption is not
available anyway: the Core sees only a Conversation Key, and telling `spaces/X`
from `spaces/X/threads/Y` means counting slashes, which is Chat knowledge
ADR-0003 keeps out of the Core.

**Falling back rather than going without.** No display name means
`<from>users/17</from>`. The marker is never absent, because an absent marker is
the misattribution above.

**Composed in the Core, after `readCommand`.** An Adapter may not prefix the
text: `readCommand` requires the whole message to be `/stop` or `/new`, so a
prefixed `[Ada] /stop` stops being a Command, permanently — and Commands are
recognised in the Core and nowhere else. The marker rides on the text because a
process serves a whole Session and its environment and arguments are fixed at
spawn, which is the argument ADR-0008 already made about the Installation Token.
The line written to stdin is the only per-Turn channel there is.

**Only the first line is roma's.** Anyone who can message roma can type something
that looks like a marker, and roma's own goes above whatever they sent. This is a
rule about the agent not being confused, not a privilege boundary: ADR-0008
establishes that everyone who can reach roma reaches the whole Installation, so
there is no privilege here to forge.

### Every instruction says who it is for

`TaskAddress` gains `caller` and `callerName`, so every `OutboundInstruction`
carries them — `progress` included.

An Adapter cannot work this out for itself. The Task id is minted in the Core,
after `toIngress` has returned, so an Adapter holds no link between the event it
read and the instruction it is later handed; and the Conversation Key is not that
link either, since one Conversation can have two Tasks in flight. On every
instruction rather than only the ones that end a Task, for the reason `taskId` is
on every one: an Adapter should not have to ask what kind of thing it is looking
at before it knows who it is for.

### Chat mentions the Caller on the acknowledgement and on the result

`<users/{user}>` is Google's documented syntax and `caller` is already a Chat
user resource name, so the mention is the identity in angle brackets with nothing
looked up.

Both messages, because they fail differently: two acknowledgements mutating side
by side in a thread are indistinguishable without it, and the result is what
CONTEXT.md defines as the message people search for, quote and reply to months
later. Chat has no quoted reply — `messageReplyOption` addresses a thread, not a
message — so a mention is the only mechanism.

The mention is counted inside the 4096-character limit rather than added after
the split, so that addressing an answer can never be what makes Chat refuse it.
It goes on the **first** message only: each is a separate post, and a long answer
should not notify somebody once per 4096 characters of itself.

A DM gets one too. The Adapter could tell from the Conversation Key and
deliberately does not — a rule with an exception in it is a rule somebody has to
remember.

**Every message roma posts about a Task, not only those two.** `stopped`,
`failure`, `blocked` and `overflow-refused` are one family with `result` in the
Adapter, and splitting the family would mean deciding per kind whether somebody
is owed a name on it. `blocked` is the case that settles it: it carries an offer
somebody has to act on, and an unaddressed offer in a busy thread is one nobody
is sure is theirs to take.

## Consequences

- **People's names are now permanently in the Transcript.** ADR-0006 is explicit
  that the Transcript is not roma's and roma deletes nothing from it. This change
  introduces that footprint rather than inheriting it, and it is the cost that
  should be weighed first if this is ever revisited.
- **Every Turn spends a few more tokens, out of the Shared Window.** Small, and
  spent from a quota everybody shares.
- **The agent can see names and may start using them in its answers.** An
  expected effect rather than a defect. Nothing specifies how it should behave,
  and this is named so that the first person to see it knows it was foreseen.
- **The Core prints something it did not before.** It still interprets nothing:
  no comparison, no parsing, no decision turns on a Caller. A Channel that names
  people by email and one that names them by opaque id both work.
- **A DM is marked and mentioned redundantly.** Accepted, in exchange for one
  rule with no exceptions in it.
- **The `Requested-by:` trailer's format was wrong and is corrected here.**
  ADR-0008 specified `Requested-by: alice@example.com (google-chat)`. Chat's
  sender carries no email, and obtaining one means the Directory API this ADR
  rejects. ADR-0008 now names what roma actually holds. The trailer remains
  unimplemented.

## Alternatives considered

**One Session per person per thread** — Conversation Key = thread + sender.
Rejected. ADR-0008 already settled that a space is many people sharing one
Conversation and one Session, and splitting it means Ada cannot see what Bob just
asked roma to do, which is the thing a thread is for. It would also multiply
Sessions by the size of a space, against a pool that decides which are resident.

**Resolve the Caller to an email through the Directory or People API**, which is
what ADR-0008's trailer format assumed. Rejected: a scope, a network round trip
per message, and a lookup table it would want to cache — the database
`session-generation.ts` goes out of its way to say roma does not have. The id is
already stable and already unique, and the display name is already in the payload.

**Mark only when the Caller changes.** Rejected above: it needs per-Session
memory that a restart loses, and the failure it produces is silent
misattribution rather than a visible gap.

**A `Caller` type carrying both halves, instead of two fields side by side.**
Rejected, and it is the obvious objection: the pair travels together through four
types. The Audit Record has to stay flat whatever happens — that is the
back-compat argument above, and it is not negotiable — so a type would be
flattened again at the one boundary where being wrong costs money. Keeping the
in-memory shape the same as the on-disk shape is what makes that boundary
uninteresting.

**A bare `[Ada]` marker.** Rejected. It is indistinguishable from something
somebody typed, which makes "roma's marker is the first line" an unstateable
rule, and two people called Ada would be one person to the agent.

**Put the asker in the commit author field.** Already rejected in ADR-0008 on a
fact rather than a preference — roma holds a Channel identity and has nowhere to
get that person's GitHub identity — and nothing here changes it. Recorded again
because this ADR is where somebody will next look for it.
