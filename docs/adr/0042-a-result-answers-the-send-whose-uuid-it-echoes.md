# 42. A result answers the send whose uuid it echoes, and a woken Turn's result goes to whoever launched its Task

Date: 2026-11-13

## Status

Accepted, and **implemented**. Closes #234. Narrows ADR-0003's one-send-one-result
reading of a Session: a Session also writes results nobody sent for.

### Verification status

**Measured on the pinned build (2.1.319), live.** A shim stood in for `claude` inside
the 0.12.0 image and tee'd stdin and stdout. Roma itself was unchanged, and the real
`Core`, `SessionPool` and `GoogleChatAdapter` ran it, with only the Chat HTTP client
faked. One of those captures is `test/fixtures/claude-stream/background-task-woken-turn.jsonl`.

- **A finished background Task wakes the agent.** Claude Code writes a
  `task_notification`, then a Turn with no user frame behind it, whose `result`
  carries `origin: { kind: 'task-notification', runId }`.
- **0.12.0 drops that result.** It also settles a send written during the woken Turn
  with the woken Turn's text, and drops the send's own answer. Across five recordings,
  1 to 2 of 3 to 4 results never reached Chat.
- **A `uuid` on the user frame comes back.** It returns on the replayed user message
  and in `result.user_message_uuid` / `user_message_uuids`. A woken Turn's result
  echoes neither.
- **`origin.runId` equals the `run_id` of the Task's `task_started`.** A resumed
  subagent keeps its `task_id` and takes a new `run_id`, with no send pending.
- **Every top-level `task_notification` was followed by the woken Turn's `init`**,
  12 to 107ms later (12 of 12).

**Read off the types (`@anthropic-ai/claude-agent-sdk` 0.3.319, the 2.1.319 pair):**
`SDKUserMessage.uuid`, `SDKResultSuccess.user_message_uuid(s)`,
`SDKMessageOrigin` `kind: 'task-notification'`, and `background_tasks_changed` as a
level signal with replace semantics. `session_state_changed` is also in the types, but
the binary writes it only under an undocumented `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`,
so roma does not depend on it.

**Not measured:** a woken result reaching a real Google Chat space, a producer that
echoes no uuid, and the Seat launcher in the path.

## Context

`ClaudeSession` kept a `result` only while a send was pending, and settled whatever
was pending with the next one. A Session with a background subagent, shell or
workflow writes results with nothing pending. The idle reap and `#makeRoom` looked
only at `busy`, which is false between sends, so they could also end a Session in the
middle of its Task.

## Decision

### 1. A send carries a uuid, and only the result that echoes it settles it

`send` writes a fresh `uuid` on the user frame. A result settles the pending send when
`user_message_uuids` contains that uuid, or failing that when `user_message_uuid`
equals it. A producer that echoes nothing falls back to the 0.12.0 reading, except for a
result whose `origin.kind` is `task-notification`.

### 2. Every other result is one of two kinds

- **A woken Turn's result** (`origin.kind` is `task-notification`) is handed on as
  `unsolicited`. `Core` delivers it as a `result`.
- **Anything else** is the late answer of a send that was already answered (an exit, an
  error, a retry storm). It is logged as `result-late` and not delivered, because
  delivering it would answer one message twice.

### 3. A woken result goes to the Caller who launched the Task

`ClaudeSession` remembers, per `task_id`, whose Turn started the Task:

- a user Turn belongs to the uuid on its replayed user message;
- a woken Turn belongs to whoever launched the Task whose notification woke it;
- a nested Task takes its parent's launcher.

The send pending at the time is not used. During a woken Turn that send is still queued
behind the Turn, and crediting it would address the new Task's result to the wrong
Caller. This was found in review of #235. The result's `origin.runId` leads back
through `run_id` to that `task_id`. `Core` remembers the address of each recent send's
Task, keeping the last 1,000, and falls back to the Session's last Conversation address.

### 4. Background work keeps a Session busy

`backgroundBusy` is true while any of these hold:

- `background_tasks_changed` lists a non-ambient Task;
- a Turn is open, from `init` to `result`;
- a top-level Task's notification has arrived and its `init` has not.

The reap re-arms instead of retiring and logs `reap-deferred`. `#makeRoom` skips such a
Session, as it already skips a busy one.

## Consequences

- When every resident Session has background work, a new Conversation's Task is
  refused, as it is when every resident is mid-Turn.
- A Session whose woken Turn never begins stays busy. Every 15 minutes it logs
  `reap-deferred`, which is how it would be noticed.
- A woken Turn's cost moves the Session total but is not written to the audit log.
- `result-undelivered` should stay at 0. It is the operator's count of woken results
  roma could not deliver.

Enforced by `fence:session-result-binds-to-its-send`,
`fence:session-woken-turn-task-belongs-to-its-launcher`,
`fence:session-busy-while-background-work`, `fence:session-late-result-is-not-a-reply`,
`fence:pool-background-work-is-never-reaped`, `fence:pool-background-work-is-never-evicted`
and `fence:core-woken-result-reaches-its-launcher`.
