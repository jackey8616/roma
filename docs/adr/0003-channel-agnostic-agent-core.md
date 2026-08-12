# 3. Channel-agnostic agent core

Date: 2026-07-29

## Status

Accepted. With ADR-0004, supersedes ADR-0001.

**Amended 2026-07-29** after prototype verification
(`docs/transcript-collision-verification.md`, Claude Code v2.1.220), in the way
ADR-0002 was: the decisions are unchanged, and what the amendments correct is the
evidence beneath two of them. Both concern the transcript this ADR calls "not
ours to delete" — a clause ADR-0006 has since upheld deliberately. Amendments are
marked inline.

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

A third measurement came out of building the session pool, which is the first
thing to evict a process and resume it as a matter of course rather than as an
experiment. One more claim did not survive: `total_cost_usd` is a per-*process*
total, not a per-session one. That correction is folded into the observability
section below, and it is pinned the same way — `src/session-pool.live.test.ts`,
with no findings document behind it, because seam 2 is now where the stream
contract is kept honest.

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

**Amended 2026-08-12 by ADR-0028 — the two properties carry, the mechanism does
not.** This section reads as though a queue were the only thing that satisfies
them, and Discord's Gateway is a counter-example: it is a WebSocket the adapter
opens *outward*, so no port is exposed, and it imposes no deadline on answering a
message. Both bullets hold; it is not a queue, and it cannot redeliver. So what a
Transport owes the core is the pair of promises `src/transport.ts` already names
— here are the events, here is how to stop — and **durability is not among
them**. `Delivery.nack` is a no-op where there is nothing to hand back, and the
remedy for a post that failed moves to `ChannelAdapter.deliver`, which is where
the failure actually is. The heading stays as written because it is still true of
this channel and of the ingress ADR-0004 describes; read *"a queue"* as one
answer rather than the requirement.

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
  - **Eviction escalates to SIGKILL after a 5s grace.** Not a measured need —
    every SIGTERM observed has exited 143 — but the pool waits for a process to
    go before letting the next session take its slot, so a process that ignored
    SIGTERM would stall every later message rather than only its own session.
    That is the "bot halted" state under accepted risks, reached without a single
    task hanging.
  - **Which credential a turn is paid for by is a property of the process, so
    the pool owns it.** Overflow (ADR-0002) reruns one blocked task on the
    metered key, and the environment map is fixed at spawn — so the session's
    resident process is ended and resumed on the other map, and ends up back on
    the subscription for the conversation's next message. The pool takes one
    environment per credential and picks per turn.
    - It has to be the pool rather than a second pool with the other map: a
      session's transcript is one file, and two live processes on it is the
      corruption the whole serialisation rule exists to prevent. Two pools would
      make "at most one of you holds this session" an invariant neither of them
      owned. Eviction-and-resume is already routine here and already verified, so
      this is the existing mechanism with one more reason to fire.
  - **A resume that finds no transcript re-creates the session.** The pool reads
    the existence of the session's working directory as the record that the
    session exists, which is what makes the `--session-id`-then-`--resume` rule
    survive a restart of roma. The directory is created before the process is,
    so a session whose first process died before Claude Code wrote a transcript
    would otherwise be resumed forever at something that is not there — the CLI
    answers `No conversation found with session ID: …` and exits. On that, and
    only that, the pool spawns again with `--session-id`.

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

`/new` adds one qualification, and only one: the derivation also takes a
generation, and which generation a conversation is on is written down. The
mapping stays derivable and nothing is looked up — see "Where a fresh session
comes from" below.

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

**Of those two, roma suppresses** (settled when this was built, #7). The
acknowledgement is still posted once, because a task nobody has confirmed
received is what makes people resend; everything after it is dropped. Periodic
new messages at 5–10s would be thirty to sixty messages over a five-minute task,
which buries the conversation it is reporting into.

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
  - **Reclaiming a working directory also forgets that the session exists**, and
    that is a known hole rather than a design. The pool reads the directory as
    the record of existence, but the transcript `--resume` needs belongs to
    Claude Code and is not ours to delete — so a conversation that goes quiet for
    more than 7 days and then comes back is spawned with `--session-id` at an id
    that may still have a transcript. **What the CLI does with that is
    unmeasured.** Accepted for now because the alternative is a second record of
    which sessions exist, kept outside the directory it describes.
    - **Amended — measured, and it is a defect rather than an uncertainty.** The
      CLI refuses outright: `exit 1`, `Error: Session ID … is already in use.`,
      before any stream event. Nothing removes the transcript, so the id stays
      poisoned and that conversation is **permanently unservable** — every later
      message repeats the same spawn. "Accepted for now" was accepting more than
      it knew. Filed as #40, whose fix is to reach the session with `--resume`
      instead; measured to recover it having forgotten nothing. **The clause
      "not ours to delete" stands** — ADR-0006 upheld it deliberately rather
      than by inheritance.
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
- **The check drives a completed Turn, not just a spawn.** Two measurements
  forced this, both **verified** at seam 2 against v2.1.220:

  `system/init` **does not arrive on spawn**. A process left with an idle stdin
  emitted nothing at all for 5s, against the ~500ms an init takes once a message
  has been written. The cheaper design — spawn, read the stream, assert, kill —
  would not have hung a test; it would have hung the boot.

  And stopping *at* `system/init` would reproduce the blind spot below.
  `apiKeySource` and the model are reported before the first API call, so a token
  that 401s produces a perfectly healthy init. Only completing the Turn sees it.

  What that costs, measured: **3682ms and $0.0709632** per boot, the spend
  dominated by the cached system prompt rather than by the probe's four output
  tokens. A wrong credential is still refused at init in ~1.2s, without waiting
  for the Turn — which matters, because a wrong credential is precisely the case
  that then retries for three minutes.
- **Pinning `--model` narrows what the model assertion catches.** The prototype
  watched a stray `ANTHROPIC_API_KEY` move the model to `claude-opus-5[1m]`, and
  that run did not pass `--model`. With the model pinned, seam 2 measured the
  same stray key leaving the model at `claude-sonnet-5` and moving only
  `apiKeySource`. So `apiKeySource` is what catches a stray key; the model
  assertion covers the case where Claude Code stops honouring `--model` at all.
  Both are still worth asserting — they simply do not catch the same thing, and a
  reader who expects the model to give a stray key away would be wrong.
- **`claude auth status` cannot serve this purpose.** It reports
  `loggedIn: true` for any non-empty string, including a token that fails with
  401 on first use. ADR-0001's choice of a live `-p` invocation was right, and
  this is why.
- Per-task audit record: who, session, duration, cost, and which credential
  served it. One JSONL file per calendar month, because the monthly overflow cap
  is a calendar-month sum and nothing else — and under a root of its own rather
  than under the session pool's work root, which is walked by a reclaim that
  deletes whatever has gone seven days untouched. An audit log surviving a quiet
  week is the whole point of it.
  - **Both credentials are recorded — the one roma ran the task on and the
    `apiKeySource` Claude Code reported while running it.** They agree by
    construction: the environment is built per invocation and the self-check
    asserts on it at boot. Recording both anyway is cheap, and the disagreement
    it would catch is the one ADR-0002 fears most — a stray key moving every run
    onto metered billing. The alternative is discovering it from an invoice, by
    which point the month is spent.
  - **Cost has three values, because "free" and "unpriced" are different facts.**
    A number where a turn was priced; **zero** only where no turn ever began, so
    nothing can have been spent — a task stopped while it was still queued;
    **null** where a turn began and no terminal event ever arrived, which is
    where the cost is reported. A task abandoned mid-retry-storm or cut short by
    a process that died had spent real tokens that nothing will now name, and
    recording those as zero reports money as free — the same class of wrong as
    the cumulative total above, pointing the other way. A monthly total therefore
    carries a count of the unpriced tasks in it, and reads as a floor rather than
    an answer. Neither kind is omitted: a log that disagreed with the number of
    messages people sent would fail the other thing it is read for.
  - **Duration is two numbers**: the task's own wall clock, from arrival to the
    caller being told, and the turn's. The first is what a person endured and the
    only one a task stopped in the queue has; the difference between them is what
    queueing and cold start cost, which is the measurement any future argument
    about the concurrency cap needs.
- **The cost figure must be a per-turn delta.** `total_cost_usd` is a
  **cumulative process total**, not a per-turn figure — across two turns
  `modelUsage` summed: `inputTokens` 2 → 4, `outputTokens` 4 → 7, `cacheRead`
  23684 → 55867. Only the top-level `usage` object is per-turn. Logged raw on a
  resident multi-turn process, the fifth task in a session is recorded at the sum
  of tasks one through five. Take the difference between consecutive
  `total_cost_usd` values within one process, or compute from per-turn `usage`.
  ADR-0002's monthly overflow cap is built on this number.
  - **The total belongs to the process, not to the session**, which matters
    because eviction makes resume routine. This bullet, and
    `docs/headless-session-verification.md` Q4, previously called it a session
    total; both were written from a run in which one process served the whole
    session, where the two are indistinguishable. **Verified** through the
    session pool: a session that had spent **$0.0822846** was evicted with
    SIGTERM and resumed, and its first turn on the new process reported
    **$0.0105342** — with context intact, so the resume genuinely reached the
    same session. Reproduced on a second run ($0.0827067 then $0.0105543), so
    this is not one anomalous reading. A resumed process starts its own
    accounting from zero and has nothing to carry forward, so the delta baseline
    never crosses an eviction.
    Had it carried forward, the first turn after every eviction would have been
    billed the whole session, which is the failure the delta exists to prevent
    arriving exactly where eviction makes resume routine. Seam 2 asserts this
    rather than only reporting it, because a version that changed it would
    resurrect that failure silently.

### Commands

`/new` and `/stop` only.

There is no wall-clock timeout: tasks end when they finish or when a human stops
them.

**Recognised in the core, not in an adapter**, and only when the whole message is
the command. Claude Code has slash commands of its own and every one of them is
passed through as work — a prefix match would swallow commands that are not
roma's, and would swallow more of them with every Claude Code release. Neither of
roma's two takes an argument, so nothing meant for roma is turned away by that
rule.

**Amended — the decision stands; "passed through as work" was never true.** roma
passes the *text* of a Claude Code slash command, not the command. The Caller
Marker is written above every message (`attribution.ts:39`), so the frame reaching
stdin begins with `<from>` rather than with a slash, and Claude Code parses a
command only when the message starts with one. Measured on 2.1.220:
`<from>…</from>\n\n/context` returns `num_turns: 1` at `$0.0549`, and the result
is the model's prose about the command instead of the command's output — where
the same message without the marker returns `num_turns: 0` at no cost. So the
prefix-match objection above was guarding against roma swallowing Claude Code's
commands while roma was already swallowing all of them, by a mechanism the
sentence was not looking at. What the guard protects is real and is kept: `/new`
and `/stop` are still matched whole and nothing is matched by prefix. ADR-0012
takes the other half — a short whitelist relayed with the marker moved after it,
which is the only way any of Claude Code's own commands reaches it.

A command is not a task: it drives no turn, is not queued, and does not count
against the concurrency cap. That is forced rather than tidy — tasks of one
session are serialised, so a queued `/stop` would wait for the very task it was
sent to stop and arrive after it had finished.

**A stopped task is reported as stopped**, which is neither of the two endings a
task otherwise has. `terminal_reason: "aborted_streaming"` is what distinguishes
it; `subtype` says `error_during_execution`, which is what any error during
execution says. Reported as a failure it reads as roma breaking, and the text it
would carry as its reason is the half-written answer the interrupt cut off.
`/stop` with nothing in flight says so rather than saying nothing: told a task was
stopped when none was running, a person stops watching a task that is in fact
still going.

**`/stop` follows the task, not the session the conversation is on**, and the
core keeps its own record of the tasks it has taken on to do it. Two windows make
that necessary and neither is narrow. A task can be queued behind three others
and then waiting on a cold start — minutes in which it is visibly running and
there is no turn to interrupt — so a task is marked stopped as well as
interrupted: one stopped before it starts never starts, and one stopped while its
process is coming up is interrupted the moment its turn begins. And a `/new`
between the message and the `/stop` moves the conversation to a new session while
the work carries on in the old one, so asking which session the conversation is
on would interrupt an empty session and report that nothing was running.

### Where a fresh session comes from

`/new` needs a session id that is not the one the conversation is already on, and
the id is `uuidv5(<conversation key>)` — a pure derivation from a key the channel
owns and never changes. So the derivation takes a **generation**: zero is the
plain `uuidv5(<conversation key>)` every conversation starts on, and `/new` moves
the conversation to the next one.

**The generation is written to disk**, one small file per conversation that has
ever used `/new`, alongside the session working directories. Held in memory it
would survive until the next deploy and then be silently undone: the conversation
would resume the transcript it asked to be rid of, with no sign of it anywhere
except Claude Code remembering things that were supposed to be gone.

This does not reintroduce the database. Nothing is looked up — the session id is
still derived, a conversation that has never used `/new` has no record at all, and
losing every one of these files costs the conversations that rotated their last
rotation rather than roma's ability to find anybody's session.

**Rejected: resetting the session in place** — deleting the working directory so
the next spawn passes `--session-id` at the same id. It needs no new concept, but
it turns on unmeasured behaviour: Claude Code's transcript for that id is still on
disk, and what the CLI does with `--session-id` at an id it already has a
transcript for has never been run. It is the same gap the seven-day working-
directory reclaim already carries; `/new` would make it a routine path rather than
a rare one.

**Amended — the rejection stands, but not for this reason.** The behaviour has
been run: `--session-id` at an id that still has a transcript is refused outright,
so in-place reset does not silently resume — it fails to start at all. Deleting
the transcript first *does* make the id reusable, measured. So the objection is no
longer that the behaviour is unknown; it is that the step which would make in-place
reset work is deleting the only account there is of what an agent did. ADR-0006
declined to take that step, which leaves this rejected on firmer ground than it
was written on.

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
handling for progress updates, per-channel authorisation.

The container image's build and update process was on that list and is now
ADR-0007, which also carries the consequence this ADR asks for: the pinned Claude
Code version lives in the image, so moving it is a re-verification event rather
than a dependency bump.

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
