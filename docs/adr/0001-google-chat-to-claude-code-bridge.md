# 1. Google Chat to Claude Code bridge

Date: 2026-07-28

## Status

Accepted

## Context

We want a Google Chat app that forwards messages to a service running Claude
Code, so that anyone in the Workspace can drive an agent from Chat instead of a
terminal.

Two properties of Claude Code shape almost every decision below:

- **Session state lives on disk** (`~/.claude/projects/…`). `--resume <id>` must
  read the same filesystem, so the runtime cannot be stateless or recycled
  between turns.
- **A single task routinely runs for minutes.** The unit of work is a
  long-lived process, not a request/response cycle.

## Decision

### Transport

Google Chat delivers events over **Pub/Sub pull**, not an HTTPS webhook.

The VM opens no inbound ports; its firewall denies all ingress. Pub/Sub also
removes the webhook response deadline (~30s), which a minutes-long agent turn
cannot meet — asynchronous reply is the native mode rather than a workaround.

### Runtime

A **long-running GCE VM running Docker**, not Cloud Run.

Cloud Run instances are stateless, recycled, and request-bounded — all three
conflict with on-disk session state and long turns. Working around this would
mean externalising session state to GCS FUSE, adding fragility at the most
load-bearing point.

### Driving Claude Code

A **persistent `claude -p` process per active session**, with bidirectional
streaming:

```
claude -p --input-format stream-json --output-format stream-json \
       --permission-mode bypassPermissions --session-id <uuid>
```

- `--input-format stream-json` accepts realtime input, so one process serves a
  whole conversation. No cold start per message.
- `--output-format stream-json` yields structured events, which the progress-
  reporting design below depends on.
- **`--bare` is forbidden.** It skips OAuth and keychain reads and requires
  `ANTHROPIC_API_KEY`, which would break subscription auth (see ADR-0002).
  Upstream documents `--bare` as the recommended mode for scripted calls and
  states it will become the default for `-p` in a future release, so the Claude
  Code version is pinned and re-verified before any upgrade.
- Idle processes are reaped after 15 minutes; the session then resumes cold via
  `--resume`. At most 10 resident processes, evicted LRU.

### Session identity

`uuidv5(thread.name)` is the Claude Code session id. `thread.name` is a stable
`spaces/{space}/messages/{message}` string, so the mapping is derivable and
**no database is required**.

A thread is created by *replying* to the @-mention with
`messageReplyOption: REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` — an app cannot
create a thread on its own.

DMs have no threads (`spaceThreadingState` is not `THREADED_MESSAGES`), so DMs
fall back to `uuidv5(space.name)`: one long-lived session per user, resettable
with `/new`.

### Concurrency

- Messages within one session are **serialised**. This is forced, not chosen:
  two processes writing the same session file corrupt it.
- **Global cap of 3** concurrent tasks. Beyond that, queue and reply with the
  caller's queue position — unacknowledged waiting causes users to resend,
  which compounds the backlog.

### Progress reporting

Acknowledge immediately, then edit that same message in place (throttled to
every 5–10s) as stream events arrive, and post the final result as a **separate
message**.

The final result is what users later search for, quote, and reply to; burying
it inside a mutating progress message makes it hard to find.

### Isolation

- One working directory per session: `/work/<session-uuid>/`, reclaimed after 7
  days idle. A shared working directory would let concurrent sessions corrupt
  each other's checkouts, with symptoms that are very hard to diagnose.
- A local mirror of frequently used repositories, cloned from locally at session
  start — faster, and avoids repeated use of git credentials.
- Egress allowlist: the Anthropic API, our git remote, and package registries
  only. Under `bypassPermissions` this is the only protection still doing work.

### Permissions

`--permission-mode bypassPermissions`. All containment is at the container
boundary.

In headless mode nobody can answer a permission prompt, so the choice is forced.
A tool allowlist was rejected as inconsistent with the decision to expose full
Claude Code capability: it would block roughly half of real tasks while
protecting nothing, and would be progressively widened until it was a no-op with
the appearance of control.

### Observability

- **Startup self-check**: a minimal `-p` invocation at boot verifies that auth
  resolves to the subscription. Failure blocks startup. This exists to catch the
  two silent-degradation modes: a `-p` default change to `--bare`, and a stray
  `ANTHROPIC_API_KEY` in the environment.
- Per-task audit record: who, session, duration, `total_cost_usd`, and which
  credential served it.

### Commands

`/new` and `/stop` only.

There is no wall-clock timeout: tasks end when they finish or when a human stops
them. Stall detection was considered and declined.

## Consequences

**Accepted risks:**

- Three hung tasks exhaust the concurrency cap and halt the bot entirely. With
  no timeout and no stall detection, recovery requires manual intervention.
- Any Workspace member can direct Claude Code to do anything on the VM. The
  container prevents exfiltration of personal credentials; it does not prevent,
  for example, pushing a repository somewhere it does not belong.

**Follow-on work not yet specified:** rate-limit backoff, Chat API quota
handling for message edits, container image build and update process.

## Alternatives considered

**tmux `send-keys` against an interactive session.** Rejected. It offers no
reliable completion signal — screen-scraping can only guess from "the screen
stopped changing", which is indistinguishable from Claude thinking — and that
alone defeats the progress-reporting design. The TUI also carries no
compatibility guarantee, whereas `-p --output-format stream-json` is a
documented interface with per-version behaviour notes. Piping user-supplied text
into a terminal via `send-keys` additionally makes control characters an
injection surface. The motivating benefits do not hold up: most slash commands
already work in `-p`, and `--input-format stream-json` already provides a
persistent, interruptible session.

**Agent SDK instead of the CLI.** Viable and equivalent for authentication. It
becomes necessary only for `canUseTool`, which routes permission prompts back to
the caller — not needed under `bypassPermissions`. Revisit if interactive
approval is ever wanted.

**Cloud Run.** See Runtime above.

**HTTPS webhook.** See Transport above.
