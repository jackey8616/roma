# 3. Channel-agnostic agent core

Date: 2026-07-29

## Status

Accepted. With ADR-0004, supersedes ADR-0001.

## Context

roma is one central Claude Code agent that team members reach from any messaging
channel. The name is from "all roads lead to Rome": Google Chat is the first
road, not the destination.

ADR-0001 framed Google Chat as the architecture. That was a scope error rather
than a wrong decision — of its nine decision sections, only three are actually
channel-bound (how events arrive, how a conversation is identified, and whether a
posted message can be edited). The rest describe a core that has nothing to do
with which product the message came from. This ADR is that core. ADR-0004 is
Google Chat's binding to it. Splitting them is what makes adding a second channel
an adapter rather than a rewrite.

Two properties of Claude Code shape almost every decision below:

- **Session state lives on disk** (`~/.claude/projects/…`). `--resume <id>` must
  read the same filesystem, so the runtime cannot be stateless or recycled
  between turns.
- **A single task routinely runs for minutes.** The unit of work is a long-lived
  process, not a request/response cycle.

### Verification status

ADR-0001 was written from documentation and `--help` output, before anything had
been run. A prototype has since run it — branch
`prototype/headless-persistent-session`, drivers under `.scratch/proto/`, against
Claude Code **v2.1.220** (`darwin-arm64`). Findings are in
`docs/headless-session-verification.md`. Four of ADR-0001's decisions rested on
wrong assumptions; the corrections are folded into the relevant sections below
rather than kept in a separate errata document.

A second run on the same build measured the two claims this ADR previously marked
unverified — that `--include-partial-messages` emits during generation, and
whether stall detection is possible once it does. Findings are in
`docs/partial-messages-verification.md`, and those corrections are folded in the
same way. One earlier number did not survive it: see the flag's bullet below.

Two claims about the invocation itself are pinned by tests rather than by a
transcript: the **seam 2** tests in `src/claude-session.live.test.ts` drive a real
`claude -p` on the same build. They are excluded from the default test run and
run with `npm run test:seam2`. Where a decision below names one, a future reader
re-runs it rather than re-deriving it.

**Read the citations as the boundary of what is known.** Claims backed by the
prototype quote the measurement inline. Claims without one have not been run —
including some of the fixes below, which are corrections derived from a measured
failure rather than measured successes. Behaviour is version-specific; the Claude
Code version is pinned and re-verified before any upgrade.

## Decision

### The channel adapter boundary

A **channel adapter** is the only component that knows which product a message
came from. Its job is exactly two translations:

- **Inbound** — turn a channel event into an ingress message on the Pub/Sub
  topic, carrying a conversation key, a caller identity, and the message text.
- **Outbound** — turn the core's acknowledgement, progress updates, and final
  result into channel messages.

The core never learns which channel it is serving. Two capabilities the adapter
must declare, because core behaviour bends around them:

- **Message mutation** — can a posted message be edited later? Progress reporting
  runs in its full form only where this is true.
- **Conversation key stability** — a stable string identifying one ongoing
  conversation. A channel that cannot supply one must mint and persist a key
  inside its own adapter; the core stays free of identity storage.

### Ingress is a queue, not a webhook

Events reach the core over **Pub/Sub pull**. Two properties make this core rather
than incidental:

- The VM opens no inbound ports; its firewall denies all ingress.
- It removes the webhook response deadline (~30s), which a minutes-long turn
  cannot meet. Asynchronous reply becomes the native mode rather than a
  workaround.

**Which channel publishes to the topic, and how, is the adapter's problem.**
Google Chat delivers to Pub/Sub natively, so its inbound adapter is nearly empty
(ADR-0004) — that is a fact about Google Chat, not about roma. A channel without
native delivery needs an HTTPS receiver inside its own adapter that publishes
onward. That receiver, not the core, holds the open port.

### Runtime

A **long-running GCE VM running Docker**, not Cloud Run.

Cloud Run instances are stateless, recycled, and request-bounded — all three
conflict with on-disk session state and long turns. Working around this would
mean externalising session state to GCS FUSE, adding fragility at the most
load-bearing point.

### Driving Claude Code

A **persistent `claude -p` process per resident session**, with bidirectional
streaming:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --include-partial-messages --replay-user-messages \
       --permission-mode bypassPermissions \
       --model claude-sonnet-5 \
       --session-id <uuid>
```

Substitute a uuid and that runs as printed — **verified** as the flag set seam 2
spawns, in `src/claude-session.live.test.ts`, *"a Session over a real `claude -p`"*.
Resuming an existing Session replaces the last line with `--resume <session-id>`,
and that is the only thing that varies between a first spawn and a resume. Two
parts of the block are load-bearing in a way they do not look — `--verbose`, and
that last line — and each has its own bullet below.

- `--input-format stream-json` accepts realtime input, so one process serves a
  whole conversation. **Verified:** two messages into one process retained
  context and the process stayed alive throughout. Cold start 2335ms; turn 1
  (including cold start) 5900ms; turn 2 warm 2942ms — roughly **2.3s saved per
  message**. That measurement is the entire quantitative basis for keeping
  processes resident, and it holds.
- `--output-format stream-json` yields structured events.
- **`--verbose` is a precondition of `--output-format stream-json` under
  `--print`, not a verbosity preference.** Without it the process exits before a
  single event reaches the stream. **Verified** against Claude Code **v2.1.220**:

  ```
  Error: When using --print, --output-format=stream-json requires --verbose
  ```

  Earlier revisions of the block above omitted the flag and therefore printed an
  invocation that does not start. Pinned by seam 2 —
  `src/claude-session.live.test.ts`, *"`--output-format stream-json` under
  `--print` › refuses to start without `--verbose`"*.
- **`--include-partial-messages` is required, not optional.** Without it the
  stream goes completely silent during pure token generation. **Verified, with
  the same prompt run both ways back to back:** flag on, **209 events** in the
  turn, worst gap between them **2641ms**, and **0 of 207** mid-stream gaps over
  3s; flag off, **6 events**, the whole 17093-character answer arriving in a
  single `assistant` event after **66747ms** of dead stream. Tool-using turns
  emit events steadily; generating turns emit nothing at all.
  - This bullet, and `docs/headless-session-verification.md` Q2, previously
    quoted **10368ms** as that silence. It is a floor, not a maximum: that gap
    was ended by the prototype's own interrupt on a 15-second timer, not by the
    model — the turn ended `aborted_streaming` after 2881 characters — so it
    measures how long the driver waited before cutting the turn off. The figure
    run to completion is the 66747ms above, and because it is a function of
    output length it has no ceiling either. The flag is more load-bearing than
    the old number implied, not less.
  - Still unmeasured: **n = 1 per arm, one prompt.** 2641ms is the largest gap in
    a single 72-second generating turn, not a distribution.
- `--replay-user-messages` returns our own input as a `user` event with
  `isReplay: true`, a `uuid`, and a `session_id`. That is enough to correlate our
  messages to their streams across a pool of concurrent sessions.
- **`--model claude-sonnet-5` is pinned explicitly.** The model is the dominant
  cost and capability variable and it is not stable by default: under the OAuth
  token every prototype run used `claude-sonnet-5`, while a stray
  `ANTHROPIC_API_KEY` silently switched it to `claude-opus-5[1m]`. Pinning does
  not change observed behaviour — it converts a silent drift into a mismatch the
  startup self-check can assert on.
- **`--bare` is forbidden.** It skips OAuth and keychain reads and requires
  `ANTHROPIC_API_KEY`, which would break subscription auth (see ADR-0002).
  Upstream documents `--bare` as the recommended mode for scripted calls and
  states it will become the default for `-p` in a future release, which is one of
  the two silent-degradation modes the startup self-check exists to catch.
- **`--session-id` and `--resume` never appear together in an invocation roma
  makes.** The CLI's own reason is narrower than a flat exclusion — **verified**
  against Claude Code **v2.1.220**:

  ```
  Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.
  ```

  The two flags do combine, but only to fork. **roma never forks**: every
  invocation either creates a Session or resumes one, and nothing in this ADR or
  in the pool below branches an existing Session into a second one. So
  `--fork-session` is never passed, the exclusion holds for every invocation roma
  makes, and the first-spawn-versus-resume rule in the next bullet is unaffected.

  Recorded because the correction narrows the *reason*, not the decision. It was
  previously stated as flat mutual exclusion, on the grounds that resuming
  already names the Session; a future reader who wants forked Sessions would be
  wrong to conclude from that the two can never appear together. Pinned by seam 2
  — `src/claude-session.live.test.ts`, *"`--session-id` and `--resume` › are
  refused together, and refused for that reason rather than a missing Session"*,
  which runs `--resume` alone as a control so the refusal cannot be a
  missing-Session error wearing a disguise.
- Idle processes are reaped after 15 minutes; the session then resumes cold via
  `--resume`. At most 10 resident processes, evicted LRU. **Verified:** SIGTERM
  mid-turn exits **143** as documented, and a subsequent `--resume` recovered the
  session with context intact. Eviction-and-resume is sound.

### Reading the event stream

Three facts the wrapper must be built around, all of them found by the prototype
and none anticipated by ADR-0001:

- **End of turn is unambiguous.** Every turn ends with exactly one terminal
  `result` event — one per *turn*, not one per process exit — carrying
  `stop_reason`, `terminal_reason`, and `is_error`.
- **Key completion on `is_error`, never on `subtype`.** `is_error: true`
  co-occurs with `subtype: "success"` on every auth failure observed. A wrapper
  keying on `subtype` alone reports failures as successes.
- **`system/init` is re-emitted at the start of every turn**, not once per
  process. The process is genuinely persistent; a wrapper that reads `system/init`
  as "a new process started" will be wrong.

### Session identity

The session id is `uuidv5(<conversation key>)`, where the conversation key comes
from the adapter. The mapping is derivable, so **no database is required**.

Channels that cannot supply a stable key mint and persist one inside their own
adapter. The core's rule is only that the key is stable and that the id derives
from it; every channel-specific detail of *what* the key is belongs in that
channel's ADR.

**Not decided:** whether one session can be reached from more than one channel.
The rule above derives an id from a single conversation key, which implies one
channel per session unless an adapter deliberately shares a key. Nothing here
depends on resolving it yet.

### Concurrency

- Messages within one session are **serialised**. This is forced, not chosen: two
  processes writing the same session file corrupt it.
- **Global cap of 3** concurrent tasks. Beyond that, queue and reply with the
  caller's queue position — unacknowledged waiting causes users to resend, which
  compounds the backlog.
- **A retry-storm cap is part of this decision, not follow-on work.** A bad
  credential does not fail fast: the prototype saw **10 `api_retry` events across
  182 seconds**, with backoff stretching to ~35s between attempts, before the 401
  surfaced. One misconfigured credential therefore holds a concurrency slot for
  over three minutes. With a cap of 3, a credential misconfiguration alone
  reaches the "bot halted" state listed under accepted risks below — without any
  task hanging. A task is abandoned after a bounded number of `api_retry` events
  (or a fixed retry wall-clock), releasing the slot and surfacing the error.

### Stopping a turn

`/stop` sends the SDK control message over stdin:

```json
{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}
```

**Verified**, and the result is better than ADR-0001 assumed:

- `control_response` `{"subtype":"success","response":{"still_queued":[]}}` in
  **~20ms**
- the turn ends with `subtype: "error_during_execution"`,
  `terminal_reason: "aborted_streaming"`, `is_error: true`
- `[Request interrupted by user]` is injected into the transcript
- **the process stays alive** — same pid, and the next message is served normally
- the aborted turn cost **$0.000625**

ADR-0001 assumed stopping a turn costs the resident session and would need
SIGTERM plus `--resume`. It does not. SIGTERM remains in use for LRU eviction
only.

### Progress reporting

Acknowledge immediately, then update that acknowledgement in place (throttled to
every 5–10s) from partial-message events, and post the final result as a
**separate message**.

The final result is what users later search for, quote, and reply to; burying it
inside a mutating progress message makes it hard to find. That rule is
unconditional. Where an adapter declares no message mutation, progress degrades
to periodic new messages or is suppressed entirely — the final result still
arrives on its own.

ADR-0001 specified updating "as stream events arrive", which was written without
knowing that generation emits no events at all. The throttle has something to
throttle only because of `--include-partial-messages`. **Verified:** with the flag
on, the longest a renderer would have waited for new content during generation was
**2641ms** — shorter than even the 5s floor of the 5–10s throttle above, so every
scheduled update had fresh text to show. The prose arrives as
`stream_event.event.delta.text`; the complete final message still arrives as its
own `assistant` event, 85ms before the terminal `result`, so the
separate-final-message rule is served from that event rather than from the deltas.

**Stall detection stays declined, and the evidence for it is narrower than it
was.** The original ground was that generation is silent, which makes "stalled"
and "thinking" indistinguishable. That no longer holds: with the flag on, **0 of
207** mid-stream gaps in a 72-second generating turn exceeded 3s. What survives is
tool execution. The stream marks a tool starting and then says nothing until it
finishes — **25339ms** of silence in a turn whose largest generating gap was 208ms
— and tool runtime is unbounded, so a stalled tool call and a slow one are the
same signal, and no threshold separates them without also killing legitimate work.
The decision stands on its original ground: no timeout, humans stop tasks.

**What makes that tolerable is that the wrapper always knows which phase a silence
belongs to**, from the last event before it. A gap after `text_delta` is
generation; a gap after the `assistant` message carrying `tool_use`, or after
`system/task_started`, is a tool running — and `system/task_started.description`
names the running tool, so the progress message can show *what* is running through
a window in which nothing else arrives.

**One hole remains in "generation is no longer silent": long thinking phases are
uncharacterised.** The two thinking blocks measured lasted **14ms** and **372ms**.
Whether a 30-second extended-thinking phase streams `thinking_delta` steadily or
goes quiet is unmeasured — and `thinking_delta` carries `"thinking": ""` with only
an `estimated_tokens` count, so a renderer can say thinking is happening and
roughly how much, never what.

### Isolation

- One working directory per session: `/work/<session-uuid>/`, reclaimed after 7
  days idle. A shared working directory would let concurrent sessions corrupt
  each other's checkouts, with symptoms that are very hard to diagnose.
- A local mirror of frequently used repositories, cloned from locally at session
  start — faster, and avoids repeated use of git credentials.
- Egress allowlist: the Anthropic API, our git remote, and package registries
  only. Under `bypassPermissions` this is the only protection still doing work.

### Permissions

`--permission-mode bypassPermissions`. In headless mode nobody can answer a
permission prompt, so the choice is forced. A tool allowlist was rejected as
inconsistent with the decision to expose full Claude Code capability: it would
block roughly half of real tasks while protecting nothing, and would be
progressively widened until it was a no-op with the appearance of control.

**Containment is designed at the container boundary, but that is not the whole
picture.** ADR-0001 claimed it was. The prototype found `sleep 45` refused with
`<tool_use_error>Blocked: standalone sleep 45` — an independent guard layer exists
beneath the permission mode. It is undocumented and **must not be relied on**;
the container boundary remains the only containment we design for. It is recorded
here so a future reader does not mistake an occasional refusal for a bug in our
wrapper.

### Observability

- **Startup self-check**: a minimal `-p` invocation at boot. It asserts on
  `system/init.apiKeySource` — `"none"` under the OAuth token,
  `"ANTHROPIC_API_KEY"` when a key is present — and on the model reported in that
  same event. Failure blocks startup. This catches the three silent-degradation
  modes: a `-p` default change to `--bare`, a stray `ANTHROPIC_API_KEY`, and a
  model swap.
- **`claude auth status` cannot serve this purpose.** It reports
  `loggedIn: true` for any non-empty string, including a token that fails with
  401 on first use. ADR-0001's choice of a live `-p` invocation was right, and
  this is why.
- Per-task audit record: who, session, duration, cost, and which credential
  served it.
- **The cost figure must be a per-turn delta.** `total_cost_usd` is a
  **cumulative session total**, not a per-turn figure — across two turns
  `modelUsage` summed: `inputTokens` 2 → 4, `outputTokens` 4 → 7, `cacheRead`
  23684 → 55867. Only the top-level `usage` object is per-turn. Logged raw on a
  resident multi-turn process, the fifth task in a session is recorded at the sum
  of tasks one through five. Take the difference between consecutive
  `total_cost_usd` values within a session, or compute from per-turn `usage`.
  ADR-0002's monthly overflow cap is built on this number.

### Commands

`/new` and `/stop` only.

There is no wall-clock timeout: tasks end when they finish or when a human stops
them.

## Consequences

**Accepted risks:**

- Three hung tasks exhaust the concurrency cap and halt the bot entirely. With no
  timeout and no stall detection, recovery requires manual intervention. The
  retry-storm cap closes the one non-hang path into this state that we know of;
  it does not close the risk.
- Any member of any connected channel can direct Claude Code to do anything on
  the VM. The container prevents exfiltration of personal credentials; it does
  not prevent, for example, pushing a repository somewhere it does not belong.
- **Adding a channel widens that blast radius, and the core cannot see it.** The
  core has no notion of which channel a caller came from, so a channel with
  weaker membership control than the Workspace grants exactly the same
  capability. Per-channel authorisation is not specified.

**Follow-on work not yet specified:** rate-limit backoff, per-channel API quota
handling for progress updates, container image build and update process,
per-channel authorisation.

## Alternatives considered

**A separate bot per channel, with no shared core.** Rejected. Every one of them
would need its own session pool, its own working-directory tree on the same VM,
and its own concurrency accounting against the same shared subscription window.
The core is where all the difficulty lives — session lifetime, serialisation,
isolation, cost attribution — so duplicating it per channel duplicates the
difficulty and the bugs, in exchange for an adapter layer that is thin by
construction.

**tmux `send-keys` against an interactive session.** Rejected. It offers no
reliable completion signal — screen-scraping can only guess from "the screen
stopped changing", which is indistinguishable from Claude thinking — and that
alone defeats the progress-reporting design. The TUI also carries no
compatibility guarantee, whereas `-p --output-format stream-json` is a documented
interface with per-version behaviour notes. Piping user-supplied text into a
terminal via `send-keys` additionally makes control characters an injection
surface. The motivating benefits do not hold up: most slash commands already work
in `-p`, and `--input-format stream-json` already provides a persistent,
interruptible session — the prototype's in-band interrupt confirms the
interruptible half directly.

**Agent SDK instead of the CLI.** Viable and equivalent for authentication. It
becomes necessary only for `canUseTool`, which routes permission prompts back to
the caller — not needed under `bypassPermissions`. Revisit if interactive
approval is ever wanted.

**Cloud Run.** See Runtime above.

**HTTPS webhook as the core ingress.** See "Ingress is a queue" above. Note this
is rejected as the *core's* ingress; an individual adapter may well need one
internally, and publish onward to the topic.
