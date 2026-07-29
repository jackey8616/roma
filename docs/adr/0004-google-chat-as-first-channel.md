# 4. Google Chat as the first channel

Date: 2026-07-29

## Status

Accepted. With ADR-0003, supersedes ADR-0001.

## Context

ADR-0003 defines the channel-agnostic core and the adapter contract every channel
binds to. This ADR is Google Chat's binding — the first road.

Everything here is a fact about the Google Chat API. **None of it generalises.**
When a second channel is added, only ADR-0003's rules carry over; the specifics
below are expected to have no counterpart.

## Decision

### Inbound: Pub/Sub pull, no receiver of our own

Google Chat delivers events to a Pub/Sub topic directly. The Chat adapter's
inbound path is therefore nearly empty: it subscribes and republishes into the
core's ingress format. No HTTPS receiver, no open port, and the VM's firewall
denies all ingress.

ADR-0003 requires events to reach the core over a queue and removes the ~30s
webhook response deadline that a minutes-long turn cannot meet. Google Chat
satisfies that requirement natively. That is Chat's convenience, not the
architecture's design — the next channel is likely to need a receiver inside its
own adapter.

### Conversation key: the thread, falling back to the space

- **In spaces:** `thread.name`, a stable `spaces/{space}/threads/{thread}`
  string. The session id is `uuidv5(thread.name)`, so the mapping is derivable
  and no adapter-side storage is needed.
- **A thread is created by *replying*** to the @-mention with
  `messageReplyOption: REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`. An app cannot
  create a thread on its own, so the first reply is what establishes the key.
- **In DMs there are no threads to speak of**, so DMs fall back to
  `uuidv5(space.name)`: one long-lived session per user, resettable with `/new`.
  A DM is recognised by `space.spaceType == "DIRECT_MESSAGE"`, or by the
  deprecated `space.type == "DM"` — never by the absence of a thread, because
  Chat puts a thread on every message including a DM's, and that one names the
  single message. Read as the key it would make every message in a DM its own
  session.

#### Corrected 2026-07-29, against the API reference

Two facts above were wrong in this ADR's first version, carried in from ADR-0001
and never run. Both are corrected in place, per the same rule ADR-0003 follows.

- **A thread's resource name is `spaces/{space}/threads/{thread}`,** not
  `spaces/{space}/messages/{message}` — that is a *message's* name. An adapter
  built on the old text would parse a real thread key as malformed and never
  reply in a space at all.
- **`spaceThreadingState` is not the DM test.** It is documented **output only**
  on the Space resource, so an event payload need not carry it; and
  `GROUPED_MESSAGES` spaces have threads too, so "not `THREADED_MESSAGES`" does
  not mean "no threads". Keying on it sends every message in a space down the DM
  path: one session for a whole space, with everybody's context in everybody
  else's replies.

Sources, both read on 2026-07-29:
[spaces.messages](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages)
and [spaces](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces).

**Still unverified, and it needs a Workspace:** which fields a Chat interaction
event actually carries. The reference documents the *resources*, not the event
payload, so the adapter reads only fields whose absence it can survive — it asks
whether the space is a DM by two names, and takes the thread from the message
rather than the threading state from the space. The first real event is what
closes this.

The ingress subscriber has since landed (#13) and it does **not** close it. The
subscriber decodes the envelope — Chat publishes the event as JSON in the Pub/Sub
message body — and hands the result to the adapter unread, so it verifies nothing
about the fields inside. What closes this is running against a real Workspace and
looking at one.

### Declared adapter capabilities

- **Message mutation: yes.** Chat supports editing a posted message, so progress
  reporting runs in its full ADR-0003 form — acknowledge, edit that
  acknowledgement in place, post the final result as a separate message.
- **Conversation key stability: yes.** No adapter-side identity storage.

### Outbound: plain text, and what 4096 characters forces

Messages are **plain text**. Nothing in the core's outbound instructions needs a
card yet, and a long answer inside a card is worse than a plain one at the two
things the separate-result rule exists for: being searched for and being quoted.
Cards arrive with Overflow, which needs a button anyone can press; until then
they would be decoration with a schema attached.

**Chat's text limit is 4096 characters, and it is the ordinary case rather than
an edge** — the recorded generating turn in `test/fixtures/claude-stream/` is
17706. A result longer than that is therefore posted as several messages, broken
at a paragraph boundary where there is one. The alternative is that the longest
answers, which are the ones worth having, are the ones that never arrive.

Two consequences worth naming, because neither is obvious from the core side:

- **The acknowledgement shows the *end* of a partial answer, not the beginning.**
  Frozen at the first 4096 characters it would stop moving halfway through a long
  answer, which is what a dead task looks like — and staying visibly alive is the
  whole job of that message.
- **`/stop` produces two messages**: one answering the person who typed it, and
  the stopped task's own outcome on the acknowledgement they were watching.

### Caller identity

The adapter passes the Chat sender through as the caller identity on every
ingress message, which is what ADR-0003's audit record logs as "who". Per ADR-0002
there is no per-user attribution at the provider, so this log is the only place
usage can ever be attributed to a person.

## Consequences

- **Any Workspace member can drive the agent.** Membership control is the
  Workspace's, not ours. ADR-0003 records the corresponding blast-radius risk;
  what bounds it today is entirely Google Workspace membership.
- **Chat API quota for message edits constrains the progress-update throttle.**
  The 5–10s interval in ADR-0003 was chosen for readability, not against a quota
  figure. Not yet specified.
- **The DM fallback is a session with no natural end.** One session per user,
  growing until `/new`. Threads are self-limiting; DMs are not.

## Alternatives considered

**An HTTPS webhook from Google Chat.** Rejected. It would require an inbound port
on the VM and would impose the ~30s response deadline that a minutes-long turn
cannot meet — for a channel that offers queue delivery for free.
