# 11. An Enclosure lands on disk, named by roma

Date: 2026-07-30

## Status

Accepted, and implemented in #92. What is still unverified is #93.

Extends ADR-0003's inbound contract, which reduced a Channel event to "a key, an
identity, and some text". The reduction stands; what changes is that *some text*
was never the whole of what a person sends, and a Channel that had more to hand
over had nowhere to put it.

Corrects a sentence in ADR-0008's account of the Working Directory — that roma
puts nothing into it — without disturbing the decision that sentence was made
for. ADR-0008 is about *repository code*: the agent clones, roma does not check
out. That remains true. What roma now writes there is not code and was not
fetched from GitHub; it is what somebody sent.

### Verification status

Two premises are verified and one is not, and the difference matters enough to
say before the decision rather than after it.

**Verified**: everything this ADR claims about roma. `toIngress` is synchronous
(`serve.ts:285`), the Working Directory is `join(workRoot, sessionId)` and the
Session id is the Core's (`session-pool.ts:507`), the text handed to Claude Code
is one `text` content block (`claude-session.ts:313`), and a message whose text
is empty is dropped without an answer (`chat-events.ts:86`).

**Verified**: that Claude Code's Read tool renders an image from disk into the
Turn — measured on the pinned build, not read in the documentation
(`docs/enclosure-read-verification.md`, Claude Code v2.1.220). It is
`src/claude-session.live.test.ts` rather than a capture, so it re-runs when the
pin moves. The run also settled something this ADR argued for rather than
measured: given the marker and no instruction to open anything, the agent went
and read the file.

**Not verified**: that roma can obtain the bytes from Google Chat at all. An
attachment arrives as one of two things, and they are not equally reachable —
`attachmentDataRef` is Chat's own storage and is fetched with the app's
credentials, while `driveDataRef` points into the *sender's* Drive, which roma
has no scope for and no consent from. If the second is unreachable, this ADR
still holds and the refusal path below is the one that carries it. Implementation
starts by finding out, not by building.

## Context

roma is text end to end, and it is text by omission rather than by decision —
nowhere in the repo is there a sentence saying images were considered. Four
places make it so, and the first is the one that matters:

| Where | What happens |
| --- | --- |
| `chat-events.ts:83` | Reads `argumentText`/`text`. `message.attachment[]` is never looked at. |
| `chat-events.ts:86` | A message with no text returns `null`. roma posts nothing at all. |
| `channel-adapter.ts:42` | `IngressMessage` is `{ conversationKey, caller, callerName, text }`. |
| `claude-session.ts:313` | The frame written to stdin is one `{ type: 'text' }` block. |

The second row is the user-visible fault. Somebody pastes a screenshot and asks
nothing in words — the most ordinary thing there is to do in a chat window — and
roma does not answer, does not acknowledge, and leaves no trace anybody in the
Conversation can see. The rule producing that has a good reason written beside
it:

> A bare @-mention with nothing after it is not a request. Answering it would
> spend a Turn asking Claude Code what to make of an empty message.

The reason is right and the rule is wrong, for a reason that did not exist when
it was written: it measures "is this a request" by "is there text", because at
the time there was nothing else in a message to measure.

## Decision

**What arrives with a message is an Enclosure: a file roma writes into the
Working Directory, under a name roma chose.**

### An Enclosure is a file, not a content block

Claude Code's stream-json input takes content blocks, so an image could be handed
over as one and never touch a disk. It is not, because a content block serves
images and nothing else. A 40MB log cannot be one; a file can be, and Claude
Code's Read tool renders an image as readily as it reads text — measured, on the
pinned build (`docs/enclosure-read-verification.md`). One mechanism covers what
people actually send.

The second reason is that a file can be worked on. An image in a content block
can be looked at. An Enclosure on disk can be cropped, diffed, grepped, and fed
to whatever the agent installs — and an agent that can only look at what it was
sent is a narrower agent than roma is otherwise trying to be.

This costs something real. A content block would land in the Transcript, which is
the only account there is of what an agent did and one roma never deletes; an
Enclosure lands in the Working Directory, which ADR-0003 reclaims after seven
idle days. The gap is narrower than it looks — a Read tool result carrying an
image goes into the Transcript like any other, so what a Turn actually saw is
still recorded — but it is not nothing: after the reclaim the agent can no longer
open the file a second time, and the Transcript's account of it is whatever was
read at the time.

### roma names the path; the sender's filename is data

The file on disk is named by roma. What the sender called it travels beside the
path as a string and never becomes one.

`contentName` is attacker-controlled, and using it as a path means defending
three things at once — traversal out of the Working Directory, collision between
two people sending `screenshot.png` into one Conversation, and whatever a
filesystem does with 200 characters of Unicode. Getting one of the three wrong is
the kind of fault that is invisible until it is used.

But a name roma minted and nothing else would cost the agent something it needs.
An image does not care what it is called; a log does. `nginx-error.log` and
`app-debug.log` ask to be read differently, and an agent handed `a3f9c2.log` has
been denied the one clue that was in the message.

So both, and the split is the point: the original name is printed and never
interpreted. It is the same shape `callerName` already has — a Channel-supplied
string that roma carries, prints, and decides nothing by. The marker Claude Code
is given names both halves:

```
<from>Ada (users/17)</from>
<enclosure path="./…/a3f9c2.png" name="screenshot.png" />

what's wrong with this?
```

This does not make the marker forgeable in any way it was not already. Anybody in
a Conversation can type a line that looks like an enclosure tag — and can equally
type "read ./a3f9c2.png" in prose, to exactly the same effect, because everyone
sharing a Conversation shares one Session and one Working Directory. ADR-0008
settled that there is no privilege here to forge. What does change is the
statement of the rule: "only the first line is roma's" was always shorthand for
"roma's part is tag-delimited and comes first", and with two tags the shorthand
stops being usable.

### The bytes are fetched late, and `toIngress` stays synchronous

`toIngress` returns `IngressMessage | null` with no promise in it, and downloading
an attachment is neither fast nor synchronous. Rather than make the whole inbound
seam async, `IngressMessage` carries the Enclosure as something not yet fetched —
its declared name and a way to obtain it — and the Core redeems that only once it
knows the Session, streaming to the Working Directory.

Late rather than eager, for three reasons that all say the same thing: an eager
download pays for work that may never be wanted. A Task can sit in the Task
Queue behind others; a Task can be Parked for hours, which CONTEXT.md defines as
"holding no concurrency slot and no process" and which an in-memory buffer would
quietly contradict; a Task can be stopped. And the size is chosen by whoever sent
the message, so eager buffering puts roma's memory under the control of anybody
who can message it.

Synchronous rather than async because making `toIngress` return a promise
conscripts every future Channel into an async read path for one Channel's
property. ADR-0003's interface is marked provisional and the second Channel is
expected to change it — so this is a preference for changing it *then*, on
evidence, over widening it now on one data point.

What this costs is the shape of `IngressMessage`. It is a plain record today,
serialisable and writable as a literal in a test, and a thing that must be called
to be redeemed is not that. It is therefore a named type rather than a bare
function: a reader should be able to see that something here has not happened
yet.

An eager download had one property worth naming before dismissing it — it
happens before the Delivery is settled, so a failure could be left to the
Transport to redeliver, which is retry roma already has. That property inverts on
the failure that is most likely to be real. An attachment roma structurally
cannot fetch — a `driveDataRef`, if the unverified claim above holds — fails
identically on every redelivery, and free retry becomes a poison message.

### A message carrying an Enclosure is a request, whatever its text

The `text === ''` rule is restated: what is not a request is a message with
*nothing* in it. Text and Enclosures are two ways of carrying something, and a
message with either is answered.

A pasted screenshot with no words carries more than most one-line messages do.
The cost is that in a DM — where roma receives every message rather than only
the ones mentioning it — an image sent for somebody else's benefit now spends a
Turn. That is accepted: a DM to roma is a message to roma.

### An Enclosure that cannot be fetched fails the Task

No new instruction kind. `failure` already means "this Task has no result, and
here is why", and a Task whose Enclosure never arrived is exactly that. The
Caller is told, in the Conversation, with the reason.

## Consequences

- `IngressMessage` stops being a plain data record. Anything that logs, compares,
  or reconstructs one has to account for a member that is redeemed rather than
  read.
- roma writes into the Working Directory, which no part of roma did before. The
  seven-day reclaim now takes user-supplied input with it, not only work the
  agent did.
- Enclosures accumulate for the life of a Session. Nothing prunes them before the
  reclaim, and one Conversation's disk use is now something its participants
  decide.
- Two Channel capabilities are implied and neither is declared:
  whether a Channel can produce Enclosures at all, and whether it can be told a
  fetch failed. `ChannelCapabilities` has two members today and this ADR adds
  none, on the same grounds it declined to make `toIngress` async — the second
  Channel is where that question gets a real answer.
- Nothing here lets roma *send* an image. `OutboundInstruction`'s `result` is
  still `text`, deliberately: no use for the reverse direction has been named.

## Alternatives considered

**Hand the image over as a content block.** Rejected above on coverage: it serves
images and not the log file that is the next thing somebody sends, and it leaves
the agent able to look and not to work. It also rests on an unverified property
of the pinned build — that stream-json input accepts image blocks — where the
file route rests on the Read tool, which is now measured to do this
(`docs/enclosure-read-verification.md`).

**Let the Adapter write the file and put a path in `text`, changing no Core
type.** Rejected on a fact: the Working Directory is `join(workRoot, sessionId)`,
and the Session id is derived in the Core from the Conversation Key and the
Session Generation. An Adapter has neither. Buying "the Core does not change"
means teaching every Adapter about Session ids, generations and work roots, which
is the coupling ADR-0003 exists to prevent.

**Make `toIngress` async and put the bytes in `IngressMessage`.** Rejected above:
it widens the Channel contract for one Channel's property, buffers attacker-sized
payloads in memory across queueing and Parking, and pays for downloads that
`/stop` and the Shared Window make worthless.

**Fetch nothing; give the agent a shim, as the Minter gives it credentials.**
Rejected, and it is the tempting one because the pattern is already in the repo.
It fits a credential, which is small, requested at the moment of use, and
deliberately short-lived. An Enclosure is none of those. It also inverts the
default in the wrong direction: an image the agent must know to go and fetch is
an image the agent will sometimes not fetch, and the whole point is that
somebody pasted it in order to be looked at.

**Keep the sender's filename on disk, sanitised.** Rejected. Sanitising is a
denylist, and the failure of a denylist is silent and total. Since the name is
wanted for its meaning rather than for addressing anything, there is no reason
for it to be a path — and a string that is never a path needs no sanitising to be
safe.

**Accept any attachment, not only images.** Not rejected — deferred, and it costs
nothing to defer, which is the reason the file route was chosen over content
blocks. The mechanism here is indifferent to what the bytes are. What is not yet
decided is the policy: a size ceiling, whether a `driveDataRef` is refused
loudly or ignored, and whether roma declines anything at all. Deciding that
before anyone has sent a log file would be guessing.

**Drop a message that has an Enclosure and no text, as today.** Rejected above.
The rule was measuring the right thing with the only instrument it had.
