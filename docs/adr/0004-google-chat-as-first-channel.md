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

- **In spaces:** `thread.name`, a stable `spaces/{space}/messages/{message}`
  string. The session id is `uuidv5(thread.name)`, so the mapping is derivable
  and no adapter-side storage is needed.
- **A thread is created by *replying*** to the @-mention with
  `messageReplyOption: REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`. An app cannot
  create a thread on its own, so the first reply is what establishes the key.
- **In DMs there are no threads** (`spaceThreadingState` is not
  `THREADED_MESSAGES`), so DMs fall back to `uuidv5(space.name)`: one long-lived
  session per user, resettable with `/new`.

### Declared adapter capabilities

- **Message mutation: yes.** Chat supports editing a posted message, so progress
  reporting runs in its full ADR-0003 form — acknowledge, edit that
  acknowledgement in place, post the final result as a separate message.
- **Conversation key stability: yes.** No adapter-side identity storage.

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
