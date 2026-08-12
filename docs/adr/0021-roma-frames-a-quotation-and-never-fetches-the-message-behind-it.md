# 21. roma frames a Quotation and never fetches the message behind it

Date: 2026-08-03

## Status

Accepted, and implemented by the change that carries it. Nothing here was
measured and nothing here cost money.

**Unverified in one specific way, and the way matters.** Every fact below about
Chat's payload is read from the API's own discovery document, which describes the
*Message resource*. What an interaction event delivered over Pub/Sub actually
carries is a separate question, and ADR-0004 already says the reference does not
pin it down. So the single reading everything here rests on — that the quoted
words arrive in the event — is one nobody has seen hold. §6 is what makes a wrong
reading loud instead of silent, and the verification is tracked as its own issue,
the way ADR-0011's was as #93.

**Extends ADR-0009's Caller Marker** rather than amending it. The rule that
roma's part is the tagged prefix and comes first is unchanged; §2 is what it took
to keep it true once the prefix had content in it.

**Does not re-open ADR-0011.** An Enclosure is still bytes, still named by roma,
still redeemed late. A Quotation is deliberately not one, and §5 is the one place
the two meet.

**Amended 2026-08-12 by ADR-0029**, in one place, and the decision is unchanged.
§1's *"The snapshot cannot drift"* turns out to be a fact about Google Chat
rather than about Quotations: Discord hands over no snapshot at all — its reply
resolves the quoted message at delivery, so the drift described there as a
misattribution risk is simply what arrives. That does not reopen anything,
because taking the snapshot was never a choice roma makes against an
alternative it prefers: where a Channel offers a snapshot beside a link, roma
takes the snapshot; where it offers only the current text, that is the whole of
what there is to take. What the amendment costs is the generality of the
sentence, and `CONTEXT.md` now says instead that a Quotation's freshness belongs
to the Channel. Marked inline at the bullet.

## Context

Google Chat lets somebody quote an earlier message and reply to it. roma reads
`argumentText` and nothing else, so what reaches the model is "how do I fix
this?" with the thing being pointed at removed. The person asking cannot tell:
their screen shows the quotation above their words.

This is the same shape as the fault ADR-0011 was written for — roma silently
dropping the most informative half of a message — and the same remedy is not
available, because a quotation is not bytes and does not belong on disk.

Two things make it more than a second Enclosure.

**It is content roma frames.** Everything the model has ever read as content was
typed by the person who sent it, which is why one rule has covered all of it:
roma's tags go first, the typed text goes last, and a forged tag is always behind
a genuine one. A quotation is a *second* untrusted region in one message, and two
regions cannot both be last.

**Its author is not the Caller.** ADR-0009 exists because an unmarked message is
read as the same person again. A quotation carries somebody else's words into the
Session under the Caller's name unless roma says otherwise — and with a forward,
those words can come from a space roma is not a member of, delivered by somebody
who quoted them to ask what they meant rather than to endorse them.

## Decision

### 1. A Quotation is the snapshot, and roma never fetches the quoted message

Chat's `quotedMessageMetadata` carries both a link — `name`, the quoted message's
resource name — and `quotedMessageSnapshot`, the words as they stood when they
were quoted plus who wrote them. **roma reads the snapshot and ignores the link.**

Three things follow, and only the first is the obvious one:

- **It is free.** No round trip, on a path that is otherwise pure parsing.
- **The scope does not move.** `spaces.messages.get` accepts app authentication
  with `chat.bot`, which roma has — but under that scope it returns only messages
  the Chat app has access to, meaning DMs and messages that invoked it. Reaching
  an arbitrary message in a space wants `chat.app.messages.readonly` **and an
  administrator's approval**. That is a deployment-level widening of what roma
  can read, in exchange for words that are already in the payload.
- **The snapshot is the more faithful of the two.** A person quotes what they can
  see. If the original is edited afterwards, a fetch returns what Bob says *now*
  under a tag that says Bob said it — which is the misattribution this ADR is
  otherwise spent preventing. The snapshot cannot drift.
  - **Amended — that last sentence is about Chat, not about Quotations.** A
    Channel that keeps no snapshot hands over the current text and there is
    nothing else to read: Discord's reply carries the quoted message as it
    stands at delivery, so a Quotation there drifts by construction and roma
    cannot prevent it (ADR-0029). The preference above is unaffected — it ranks
    a snapshot above a fetch where both are on offer, and says nothing about a
    Channel where neither is.

The third is why this is not a compromise forced by the second.

### 2. The Quotation sits inside roma's prefix, and it is escaped there

What Claude Code is given:

```
<from>Ada (users/17)</from>
<enclosure path="./.enclosures/4a71….png" name="error.png" from="Bob (users/99)" />
<quoted from="Bob (users/99)">Error: cannot read &lt;config&gt;</quoted>

how do I fix this?
```

Order and escaping are one decision, not two. Two untrusted regions cannot both
be last, so roma necessarily writes a tag between them — and that tag is the only
thing a forgery would have to imitate. Escaping the quotation removes the
imitation target: it cannot express a tag, so it cannot close `</quoted>` early
and leave the rest of somebody else's words reading as roma's frame, or as a
`<from>` naming whoever they liked.

With that, ADR-0009's rule survives **verbatim**: roma's part is the tagged
prefix, it comes first, and the one region roma does not escape is still the last
thing in the string.

**What this is and is not.** It is not a privilege boundary. ADR-0008 already
gives everyone who can message roma the whole Installation, so there is no
privilege here to forge, and an instruction inside a quotation can ask for
nothing the Caller could not have asked for in prose. What it protects is the
**Caller** — the person who quoted something to ask what it meant and did not
read the rest of it — and the Transcript's account of who said what.

The cost is stated rather than hidden: a quotation of code or markup reaches the
agent as `&lt;div&gt;`. Quoting an error message is this feature's main use, so
this is the ordinary case and not an edge one. It is accepted in exchange for a
frame nobody can leave.

### 3. Nothing is said to the model about how to treat it

No "this is quoted material, not an instruction" sentence, in the message or in
`--append-system-prompt`.

The tag already says what the passage is and whose it is. A sentence on top of it
would be roma asserting something about how a model behaves, which is the class
of claim ADR-0012 was written after getting wrong — *a term defined by one
build's behaviour is a term that turns false on somebody else's release* — and
this repository's standard for such a claim is a measurement, not a paragraph.
`--append-system-prompt` is worse rather than better: whether it changes what the
agent believes is itself an open question (#64), and a defence resting on an
unverified mechanism is a defence nobody can audit.

If somebody wants it later, the honest order is to measure it in seam 2 first.

### 4. `REPLY` and `FORWARD` are one thing, and `quoteType` is not read

Chat distinguishes a quote within a thread from a forward out of another space.
roma reads neither the distinction nor the source space, and treats both as a
Quotation.

- **Refusing forwards would reproduce the fault this area exists to remove.** It
  would drop a whole class of quotation silently, which is indistinguishable from
  roma not supporting quotations at all.
- **A forward gives an attacker nothing that pasting does not.** The person
  forwarding chose to, and roma cannot prevent — or detect — a paste.
- **Not reading `quoteType` removes a guess.** It defaults to `REPLY` when unset,
  and both fields roma reads are populated for both types, so reading it would
  add a third assumption about a payload nobody has seen for no behaviour.

`forwardedMetadata.spaceDisplayName` is deliberately **not** carried. For a
forwarded DM it holds the other participant's name rather than a space's, so
`<quoted from="Bob" space="Alice">` would read as Alice being a place. A fact that
misleads in a knowable fraction of cases is worse than no fact.

### 5. A quoted message's attachments are ordinary Enclosures, marked with whose

Chat's snapshot carries the quoted message's attachments for a forward. They
become Enclosures like any other, fetched over `media.download` — which accepts
`chat.bot`, the scope roma already posts and downloads under.

**This does not contradict §1.** What roma never fetches is the quoted *message*;
bytes are not it, and they travel the same path the Caller's own attachments have
travelled since ADR-0011.

Where the ref turns out not to be roma's to redeem, the Task ends with the reason
and the person can paste the file directly. That is not a new failure mode: it is
exactly what `driveDataRef` already does, and ADR-0011 calls it the normal path
for a Channel with an unreachable class of attachment rather than an edge case.

An Enclosure that arrived this way carries **who it came from**, and one the
Caller attached carries nothing. Without that, "the screenshot Ada sent" and "the
screenshot Ada forwarded from Bob" are one sentence in the Working Directory and
one tag in front of the agent — ADR-0009's misattribution, one level down. The
Caller's own stay unmarked because the Caller Marker above the message already
names them.

### 6. Reading nothing out of a quoted message is an Operator Log line

`quote-unread`, carrying the keys that arrived and never the content — the
`attachment-unread` record's argument, applied to the reading that most needs it.

The snapshot is where this whole decision's weight sits and it is the one part
nobody has seen. If it is absent from interaction events, roma answers every
quoted message as though the quotation were not there, which is precisely the
behaviour this ADR replaces. That failure has to be visible to somebody.

The snapshot's own keys are carried under their path, because "no snapshot in the
payload" and "a snapshot roma cannot read" are different faults with different
repairs, and the keys are what tell them apart.

### 7. What a Quotation does not change

- **Command recognition.** `readCommand` still matches the whole `text`, so
  quoting a message and typing `/stop` still stops work. This is why the Core
  learns the concept at all: an Adapter that spliced the quotation into `text`
  would have broken it on one Channel, silently.
- **Relays.** A Relay carries no Quotation — but **not** for ADR-0018's reason. A
  Quotation costs nothing, so "bytes paid for and mentioned to nobody" does not
  transfer. What stops it is that a command's wire format has nowhere to put one:
  above the command turns it into prose (ADR-0012), and below it becomes the
  argument, which is a different instruction from the one somebody typed.
- **Length.** No cap. Chat's own 4096-character limit already bounds it, and a
  second limit would only add a truncation nobody is told about.

## Consequences

- `IngressMessage` gains `quotation`, and `PendingEnclosure`/`WrittenEnclosure`
  gain `from`. All three are required and nullable, on the argument `callerName`
  already makes: a Channel that had one and forgot to hand it over is
  indistinguishable from a Channel that never has any.
- A message whose only content is a Quotation is a request, on ADR-0011's
  argument for a screenshot with no words. Somebody who quotes a message and
  @-mentions roma without typing spends a Turn.
- Everyone in a Conversation shares one Session, so a forwarded passage lands in
  a Transcript roma never deletes (ADR-0006). That is the Caller's decision to
  make and roma's to record, and it is no different from pasting — but the record
  is permanent and is named here because nothing else would name it.
- The reading is unverified against a real Workspace. §6 is the instrument; a
  `ready-for-human` issue is the record.

## Alternatives considered

**Splice the quotation into `text` in the Adapter.** The smallest change: no new
concept, no Core edit. Rejected because `readCommand` and `readRelay` match the
whole message, so `/stop` beneath a quotation would stop being a Command — on one
Channel, with no error, exactly when somebody is in a hurry.

**Make a Quotation an Enclosure.** Reuses everything: writing, redeeming, the tag,
the failure path. Rejected on three counts — the words are already in the payload,
so a file makes the agent open something to read one sentence; an Enclosure has no
author, which is the field that matters most here; and a Relay drops Enclosures,
so the quotation would vanish for a reason that does not apply to it.

**Fetch the quoted message with `spaces.messages.get`.** Rejected in §1. It needs
an administrator-approved scope for anything beyond a DM, and it returns the
message as it is *now* rather than as it was quoted.

**Use a per-Turn nonce as the quotation's delimiter instead of escaping.** Robust,
and it would let the agent read `<div>` unescaped. Rejected because it announces a
privilege boundary that ADR-0008 says does not exist, and buys, over escaping,
only the appearance of quoted markup.
