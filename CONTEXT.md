# roma

roma is one central Claude Code agent that a team reaches from any messaging
channel. The name is from "all roads lead to Rome" — Google Chat is the first
road, not the destination.

## Language

### Reaching roma

**Channel**:
A messaging product a team member talks to roma through. Google Chat is the
first.
_Avoid_: platform, integration, client, transport

**Transport**:
The wire the ingress queue runs on. Distinct from a Channel: Pub/Sub is the
transport, Google Chat is the Channel, and more than one Channel can share a
transport.
_Avoid_: using this word for a Channel

**Channel Adapter**:
The per-Channel component that translates that Channel's events into ingress
messages and roma's output back into Channel messages. The only place
Channel-specific knowledge lives.
_Avoid_: connector, integration, plugin, bridge

**Conversation**:
The user-visible exchange on a Channel — a Chat thread, a DM. One Conversation
maps to one Session.
_Avoid_: chat, thread (thread is a Google Chat term, not a roma one)

**Conversation Key**:
The stable string an Adapter supplies to name one Conversation. The Session id
is derived from it, which is why roma needs no database.
_Avoid_: thread id, chat id, room id

**Ingress Message**:
What an Adapter hands the Core: a Conversation Key, a caller identity, and the
text. Everything else the Channel knew is gone by this point.
_Avoid_: event, payload, request

**Outbound Instruction**:
What the Core hands back to an Adapter — the result of a Task, or why there
isn't one. It says what happened, never how it should look.
_Avoid_: response, reply, command (a command is `/new` or `/stop`)

### Running work

**Core**:
The Channel-independent part of roma — the ingress queue through to the Claude
Code processes. Knows nothing about which Channel a message came from.
_Avoid_: backend, server, bridge, engine

**Session**:
The Claude Code state backing one Conversation: an on-disk transcript, a session
id, and a working directory.
_Avoid_: context, history, conversation

**Resident Session**:
A Session whose Claude Code process is currently alive, so the next message
skips cold start.
_Avoid_: warm session, active session, hot session

**Session Pool**:
What decides which Sessions are resident, and for how long. It owns spawning,
Eviction, and Reaping, and it is the only thing that knows whether a Session is
being created or reached again.
_Avoid_: process pool, session manager, cache

**Eviction**:
Ending a Resident Session's process to make room for another one. The Session
survives it — the next message resumes from the transcript on disk — so nothing
the person using it can observe changes.
_Avoid_: killing a Session, closing a Session, expiring

**Reaping**:
Ending a Resident Session's process because it has gone unused, rather than to
make room. Distinct from Eviction only in what prompted it.
_Avoid_: timing out, garbage collection, idling out

**Task**:
One message from one person, from arrival to final result. The unit that is
queued, counted against the concurrency cap, stopped, and audited.
_Avoid_: job, request, run

**Turn**:
Claude Code's own unit — one message in, one completed response out. One Task
drives one Turn.
_Avoid_: using this interchangeably with Task; they coincide today but belong to
different systems

### Paying for it

**Shared Window**:
The rolling subscription quota everyone draws on, because everyone shares one
token. When it is spent, everyone is blocked at once — including the token's
owner.
_Avoid_: rate limit, quota, budget

**Overflow**:
Running one blocked Task on metered API billing instead of the Shared Window.
Off by default and offered per-Task at the moment of blocking.
_Avoid_: fallback, API mode, paid mode, spillover
