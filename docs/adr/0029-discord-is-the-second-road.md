# 29. Discord is the second road

Date: 2026-08-12

## Status

Proposed. **Nothing here is implemented and nothing here has been run.**

**Amended 2026-08-12 by the work that keeps it** (#178–#181), with two decisions
the build had to make and this file had not: what roma's own messages are allowed
to mention, and what a deployment is asked to configure. Both are marked inline
and nothing above them changed. They are here rather than in a comment because
each is a product decision somebody could reverse, and a decision argued only
beside the line that implements it is one nobody meets before they change it.

ADR-0003 defines the channel-agnostic Core and the Adapter contract every Channel
binds to. ADR-0004 is Google Chat's binding. This is Discord's. ADR-0028 carries
the two Core changes that adding it forces; everything below is a fact about
Discord and **none of it generalises**, which is the disclaimer ADR-0004 opens
with and the reason the two documents are separate.

### Verification status

**This ADR is in exactly the position ADR-0004's first version was in — written
from documentation, before anything has been run — and that version had two facts
wrong.** Both were load-bearing: it named a thread's resource name as a message's,
and it read `spaceThreadingState` as the DM test. So the tiers below are the
point of this section rather than ceremony.

One thing is different, and it is the reason to trust these more than ADR-0004's
first draft: Discord's documentation is published from
[`discord/discord-api-docs`](https://github.com/discord/discord-api-docs), so
what follows is quoted from the source of the reference rather than paraphrased
from a rendering of it. All quotations read 2026-08-12 from `main`.

**Quoted verbatim from the primary source.** Threads: *"The created thread and the
message it was started from will share the same id"*, and on the Start Thread from
Message route, *"The id of the created thread will be the same as the id of the
source message, and as such a message can only have a single thread created from
it"* — which also *"Does not work on a GUILD_FORUM or a GUILD_MEDIA channel."*
Archiving: *"Sending a message will automatically unarchive the thread, unless the
thread has been locked by a moderator."* Guild Create carries `channels`
(*"Channels in the guild"*) and `threads` (*"All active threads in the guild that
current user has permission to view"*). Thread Create is *"Sent when a thread is
created, relevant to the current user, or when the current user is added to a
thread"*; Thread List Sync is *"Sent when the current user gains access to a
channel."* Message content: *"An app will receive empty values in the `content`,
`embeds`, `attachments`, and `components` fields … if they have not configured (or
been approved for) the `MESSAGE_CONTENT` privileged intent."* Forwards carry *"a
minimal subset of fields in a forwarded message (e.g. `author` is excluded.)"*
Interactions: *"These two methods are mutually exclusive"*, *"you must send an
initial response within 3 seconds of receiving the event. If the 3 second deadline
is exceeded, the token will be invalidated"*, and `DEFERRED_UPDATE_MESSAGE` is
*"For components, ACK an interaction and edit the original message later; the user
does not see a loading state."* A button's `custom_id` is *"Developer-defined
identifier for the button; 1-100 characters"*. Rate limits: *"All bots can make up
to 50 requests per second to our API"*, *"rate limits should not be hard coded
into your app"*, and *"IP addresses that make too many invalid HTTP requests are
automatically and temporarily restricted from accessing the Discord API.
Currently, this limit is 10,000 per 10 minutes."*

**Read, but not found in the primary source.** The **2000-character** limit on a
message's `content` — every secondary source states it and the reference section
read here did not. The **exceptions** to the message-content intent — DMs,
messages mentioning the app, and the app's own messages — which come from
Discord's developer support article rather than from the API reference, and which
the whole of the *No privileged intent* decision below rests on. That the CDN URLs
on attachments **expire**.

**Not stated anywhere read, and load-bearing.** Whether `referenced_message` and
`message_snapshots` content are *also* emptied by the message-content intent — the
reference documents the field and is silent on the gating. Whether **REST** reads
are gated by it at all, which the *Quotation* decision below assumes they are not.
Whether `MESSAGE_CREATE`'s `guild_id` is **absent** in a direct message: the field
is documented as *"ID of the guild the message was sent in - unless it is an
ephemeral message"*, and a DM having no guild is a reading rather than a
statement. Whether `GUILD_CREATE`'s `channels` is complete for a bot or filtered
by permission (#169).

**The claim this design would fail on.** Not the shared thread id, which is the
best-attested fact here and is stated twice. It is **roma lacking
`CREATE_PUBLIC_THREADS` in a channel it is @-mentioned in**: the Conversation Key
is minted as the message's id on the assumption that a thread with that id is
about to exist, and if it cannot be created, every message in that channel gets a
Session of its own, forever, with no error anybody sees. The fallback below keeps
the *reply* arriving; it does not repair the Session. A permission check at boot
is the obvious remedy and is not specified here.

## Context

ADR-0004's opening is the frame: *"all roads lead to Rome"* — Google Chat is the
first road, not the destination. Everything the Core does is already free of which
product a message came from, and the Adapter contract has been waiting since
ADR-0003 for a second Channel to test it.

Discord is a good test precisely because it agrees with Google Chat about almost
nothing. Chat delivers to a queue; Discord holds a socket open. Chat allows 4096
characters; Discord 2000. A Chat app cannot open a thread; a Discord app can. Chat
hands over a message with the app's own mention already stripped; Discord does
not.

## Decision

### Inbound: the Gateway, because there is no other way

Discord delivers messages **only** over the Gateway — an outbound WebSocket the
app opens. There is no HTTP delivery for message events, so ADR-0003's *"Ingress
is a queue, not a webhook"* describes neither half of what is available.

It satisfies both of that decision's stated reasons: no inbound port is opened, and
nothing imposes a deadline on answering. It is not a queue, and ADR-0028 is where
that is reconciled. The Gateway **is** the `Transport`; nothing publishes onward.

### Membership is the boundary, and it is weaker than the Workspace's

roma answers a single private guild, and that guild's membership is the whole of
the authorisation — the same arrangement ADR-0004 records for Chat: *"Any Workspace
member can drive the agent. Membership control is the Workspace's, not ours."*

**The difference is worth writing down rather than inheriting silently.** A
Workspace's membership is administered with an offboarding process behind it. A
guild's is administered by whoever holds Manage Server, and an invite link is
transferable and usually permanent. ADR-0003 predicted this exact case — *"a
channel with weaker membership control than the Workspace grants exactly the same
capability"* — and it is accepted here rather than repaired.

### No privileged intent: roma reads what is addressed to it

Message content is behind a privileged intent. roma does not ask for it.

It does not have to. The intent's exceptions — direct messages, messages that
mention the app, and the app's own messages — are precisely the messages roma
answers. Chat is already the same shape: `readIngressMessage` reads
`argumentText`, which is *"the message with roma's @-mention removed"*.

Three reasons, in order of weight:

- **Nothing is lost.** Behaviour is equivalent to Chat's, where an @-mention has
  always been how a space addresses roma.
- **ADR-0023 already refused configuration that lives in a vendor console.** It
  rejected registering roma's spellings as Chat slash commands partly because
  *"The registration also lives in the Chat API console rather than in this
  repository, where nothing versions it and no test can see it."* A privileged
  intent is the same object.
- **It is the one place the surface is still narrow.** Given the decision above,
  roma reading only what is addressed to it is the remaining limit worth keeping.

**The price.** In a Discord thread every message must @-mention roma again. That
is identical to Chat and contrary to Discord habit, where most bots hold the
intent. Direct messages are unaffected.

**The trap this creates.** Discord does *not* strip the mention. The Adapter must
remove it before the text reaches the Core, or `readCommand` sees `<@…> /stop`,
matches nothing, and bills somebody for a Turn — the exact fault ADR-0023 was
written to close, arriving by a different door.

### A Conversation is a thread or a DM, and roma opens the thread

The Conversation Key is derived synchronously from the event, because
`toIngress` does no I/O:

| | key | where roma replies |
| --- | --- | --- |
| no `guild_id` — a DM | `channel_id` | in place |
| `channel_id` is not one of the guild's channels — a thread | `channel_id` | in place |
| `channel_id` is one of the guild's channels — top level | `message.id` | in a thread opened from that message |

The third row works only because of the quoted fact that a thread and the message
it was started from share an id: the key minted before the thread exists is the
id the thread will have. No Adapter state, no lookup.

**This reproduces ADR-0004's model rather than inventing one**, and Discord can
complete it where Chat could not — ADR-0004 records that *"An app cannot create a
thread on its own, so the first reply is what establishes the key."*

**The rejected shape is the one ADR-0004 calls dangerous.** Keying every message
on `channel_id` is simpler and stateless, and it makes a whole text channel one
Session — which is, in ADR-0004's own words about the Chat bug it was written to
prevent, *"one session for a whole space, with everybody's context in everybody
else's replies."* That document spends a section proving the failure did not
happen in production; shipping it as the main path is not available here.

### Which channel is a thread is answered from the complete list, not the active one

The classifier asks **"is this one of the guild's channels?"** rather than "is this
a thread", and the polarity is the decision.

`GUILD_CREATE` carries both lists, and only one of them is complete: `channels`
is *"Channels in the guild"*, while `threads` is *"All active threads…"*. A thread
archived for a day is in neither — so a classifier reading the thread list
mistakes it for a channel, and one reading the channel list gets it right.
`CHANNEL_CREATE`, `THREAD_CREATE` and `THREAD_LIST_SYNC` keep the set current;
all are under the non-privileged `GUILDS` intent, so this costs no REST call and
no intent.

**Every way it can be wrong is the harmless direction**, which is the property
bought here and it is ADR-0004's own test:

- A thread read as top level — roma tries to open a thread inside a thread, is
  refused, and falls back to posting in `channel_id`, which is where the reply
  belonged. The Session was keyed on the message, so the context resets.
- A DM read as top level — the same, ending in the same place for the same
  reason.

Neither leaks and neither drops a reply. ADR-0004: *"context resets visibly on the
second message, and **nothing leaks between people**."* The refusal is also a
signal the Adapter can learn from, so a misclassification repairs itself.

**A forum needs no special case.** The Start Thread route *"Does not work on a
GUILD_FORUM or a GUILD_MEDIA channel"*, and it is never reached for one: every
message in a forum is inside a post, a post is a thread, and a thread is not in
`channels`.

### Outbound: plain text at 2000, and a reply rather than a mention

Results are plain text, split at 2000 characters on a paragraph boundary where
there is one — the rule ADR-0004 sets, at a smaller number. The recorded 17,706-
character generating turn in `test/fixtures/claude-stream/` is five messages on
Chat and nine here.

**Embeds are rejected on ADR-0004's own argument**, which is stronger on Discord:
*"a long answer inside a card is worse than a plain one at the two things the
separate-result rule exists for: being searched for and being quoted."* Discord's
search reads message content; embed text is second-class for both, and no part of
an embed can be quote-replied. An attachment is worse still — it removes from the
Conversation the thing ADR-0003 says the separate Result exists to leave in it.

**The Caller is addressed with `message_reference` on the first message and
nothing on the rest.** Chat prefixes every split piece with an @-mention because
that is what Chat has; Discord's reply is the idiomatic form and nine mentions
are not.

**One property falls out of the Conversation model for free**: a Conversation is a
thread, a thread is a channel, and rate-limit buckets are per channel — so
concurrent Tasks do not contend. The only burst is one split Result.

**Amended — roma's own messages mention nobody.** A Result is written by a model
that has read whatever anybody put in front of it, so an answer containing
`@everyone` is one prompt away; on Discord that is not a rendering detail but a
notification to a whole guild, and unlike a wrong answer it cannot be taken back.
So every message roma posts carries `allowed_mentions` with an empty `parse`,
which leaves the characters in the text and takes the ping out of them: what is
said is unchanged, and who is summoned by saying it is nobody.

This is a decision rather than a precaution, and it had to be made either way —
posting without the field is the same decision taken by default and in the other
direction. It costs the one case where a Caller asks roma to mention somebody and
gets the plain text back instead, which is the trade being made deliberately. The
reply is exempt because it is not the text's doing: naming `allowed_mentions` at
all turns the reply ping off, so `replied_user` is what keeps Discord's own
default rather than a second decision — and the reply is how a Caller is
addressed here at all.

### Pressing is typing here too, and the press is answered in three seconds

ADR-0023 holds unchanged: *"A press is a message the Caller did not have to type."*
The button carries the Command, the Adapter reads it into an ordinary
`IngressMessage`, and it travels the path a typed Command travels.

Interactions arrive over the Gateway, because *"These two methods are mutually
exclusive"* and roma registers no endpoint URL — so the buttons cost no inbound
port either.

**What is new is a deadline Chat does not have.** *"You must send an initial
response within 3 seconds… If the 3 second deadline is exceeded, the token will be
invalidated."* roma's Core takes minutes. So the Adapter's own Gateway client
acknowledges with `DEFERRED_UPDATE_MESSAGE` before the event reaches the
Transport — *"ACK an interaction and edit the original message later; the user does
not see a loading state"*, which is exactly right for a design where pressing is
typing and the card should not move. This is entirely inside the Adapter and
presses on no interface.

**`custom_id` carries the Conversation Key as well as the Command.** It holds
*"1-100 characters"*; a snowflake and `/effort high` come to about thirty. Two
things are bought. ADR-0023's stated failure mode — *"If a press does not carry
the message it was pressed on, no Conversation Key can be derived"* — cannot
arise, and neither can its Discord-specific cousin, where a card posted by the
fallback path sits in a parent channel whose id is not the key. ADR-0023's best
property survives intact: *"What the Adapter remembers between posting a card and
its being pressed. Nothing."*

Both Menus and the Overflow offer are drawn. ADR-0023 says a Channel that ignores
`options` is *"correct"* rather than degraded, so the Menus could have waited; the
Overflow offer could not, because *"the offer is the only thing in roma anybody
can answer with anything but a message"* and a Discord without it is a Discord
where Overflow can never be taken. They are done together because a partial
Adapter tests the contract partially, and testing the contract is what a second
Channel is for.

### A Quotation is completed before the Core sees it

Discord's reply carries `referenced_message` and its forward carries
`message_snapshots`, so both of ADR-0021's cases exist. Neither arrives usable.

The quoted message is somebody else's and does not mention roma, so its `content`
is empty under the decision above. Left alone, roma answers *"what do you think
about this?"* without the *this* — a question it did not receive — and ADR-0021
forbids the obvious repair: *"An Adapter that spliced a quotation into `text` would
be composing what the model reads — which is the Core's, and only the Core's."*

**So the Adapter fetches the quoted message over REST and completes the event
before `toIngress` reads it**, in the same asynchronous place the interaction
acknowledgement lives. `toIngress` stays synchronous and reads a whole event.

This rests on the unverified premise that REST reads are not gated by a Gateway
intent. **It is not a bet, because it fails into the fallback**: a fetch that is
refused or fails yields `quotation: null`, which is the same code path as not
supporting Quotations at all. The premise is filed for verification as #170, and
it is the one unverified reading a decision here actually rests on.

### Declared capabilities

- **Message mutation: yes.** Progress reporting runs in its full ADR-0003 form.
- **Conversation key stability: yes.** No Adapter-side identity storage.

## Consequences

- **Every top-level @-mention creates a thread.** A busy channel accumulates them.
  Chat has the same property and it is what makes a Conversation self-limiting.
- **A thread a moderator locks is a Conversation roma can never reach again.**
  Sending unarchives *"unless the thread has been locked by a moderator"*, and the
  key names a place roma may no longer speak in. There is no second entrance, and
  today the fact has nowhere to surface — #172.
- **A forwarded message has no author here.** `message_snapshots` excludes it, so
  `Quotation.author` and `PendingEnclosure.from` are `null` on every Discord
  forward — and ADR-0021's distinction between *"the screenshot Ada sent"* and
  *"the screenshot Ada forwarded from Bob"* cannot be expressed on this Channel.
- **A Quotation's freshness is the Channel's.** Chat snapshots at the moment of
  quoting; Discord resolves at delivery. ADR-0021's claim that a Quotation *"goes
  on saying what was quoted after somebody edits the original"* is true of Chat
  and false here. ADR-0021 is amended, and `CONTEXT.md` with it.
- **Enclosures survive the intent decision, and their URLs may not survive a
  park.** `attachments` is emptied without the intent, but only on messages roma
  does not read anyway. What does bite is that the CDN links expire while a Task
  parked for the Shared Window can wait hours — `redeem()` is allowed to reject
  and this is one of the reasons it is (#173).
- **Amended — a deployment names one secret, and may name two addresses.** The
  bot token is the whole of what roma has to be told: the token names the
  application, `READY` names roma's own user, `GUILD_CREATE` names every guild it
  is in, and membership is the authorisation. The Gateway URL and the API base
  are Discord's own addresses, so they are constants a deployment inherits rather
  than variables it states — a deployment made to state them is one that can
  state them wrong, and they must agree about the API version. They are readable
  from the environment all the same, on two grounds: a proxy, or a fake in
  something larger than a unit test, is a real thing to want and neither is
  roma's to have an opinion about; and a Channel whose configuration is one
  variable has no such state as "configured by halves", so the refusal ADR-0028
  requires would have nothing to catch. Somebody who points the API base at a
  proxy and forgets the token is refused, where with one variable they would get
  a roma that starts, serves no Discord, and ignores what they did set.
- **A retry that does not read a 429 can get roma banned from the whole API.**
  429s count toward the *"10,000 per 10 minutes"* invalid-request limit, whose
  penalty is not scoped to the channel that caused it. ADR-0028 moved the retry
  into `deliver()`; this is the constraint that retry inherits, and it has no
  counterpart on Chat, whose Adapter retries nothing.

## Alternatives considered

**Publishing Gateway events onward into Pub/Sub.** See ADR-0028.

**Asking for the `MESSAGE_CONTENT` intent.** It is a toggle in the developer
portal below 100 guilds, and it would make Quotations work without a REST fetch
and let people talk to roma in a thread without re-mentioning it. Rejected on the
three reasons above, the strongest being that it lives where nothing versions it
and no test can see it. Worth reopening if the REST premise turns out false and
the fallback proves too thin — that is a real trade, not a closed door.

**Keying every Conversation on `channel_id`.** Simplest and stateless. Rejected:
it is ADR-0004's dangerous direction shipped deliberately.

**Reading the thread list rather than the channel list.** The obvious polarity,
and it carries a hole the other does not: an archived thread is in neither list,
so it would be read as a channel. Rejected once the two lists were compared.

**The message `position` field as the thread test.** Zero state and zero I/O. The
reference calls it *"the approximate position of the message in a thread"* and
never says it is absent elsewhere or present on Gateway events. Rejected as an
unverified reading in the position where a wrong one splits a Session.

**Asking `GET /channels/{id}` and caching the type forever.** Always correct, and
it would close the one unverified premise in the classifier. Rejected because
`toIngress` is synchronous, and making it asynchronous is a change to the
provisional contract spent on a question whose wrong answer repairs itself.

**Reading the Session's Working Directory to decide whether a channel is known.**
roma already writes one per Conversation under a name derived from the key, so the
Adapter could ask the filesystem. Rejected because it reaches across the line
ADR-0003 exists to draw: the key is the Adapter's, the Session id is the Core's,
and an Adapter that reads Session state has learned something it must not know. It
also never repairs the first message, which is the one that matters.

**Rendering Results as embeds, or as an attached file.** See *Outbound*.

**An HTTP interactions endpoint.** It is the other half of a mutually exclusive
pair, and taking it would put an inbound port on the VM to receive button presses
while messages still arrived over the socket — two ingress paths, one of them
holding open the port ADR-0003 closed, for no gain.

**Shipping without buttons.** Correct for the Menus by ADR-0023's own argument,
and broken for Overflow. See *Pressing is typing*.
