# Verification: persistent headless `claude -p` on a subscription

Date: 2026-07-28
Claude Code **v2.1.220** (`darwin-arm64`, homebrew). Behaviour is version-specific.

ADR-0001 and ADR-0002 were written against documentation and `--help` output.
This records what a runnable prototype actually did. Findings that contradict
either ADR name the specific decision they break.

Method: a long-lived process spawned with an explicitly constructed environment
(`CLAUDE_CODE_OAUTH_TOKEN` only, `ANTHROPIC_API_KEY` absent,
`CLAUDE_CONFIG_DIR` pointed at a scratch directory so no keychain login was
reachable), driven over `--input-format stream-json` with every raw event
captured.

## Q1 — One process does serve a multi-turn conversation

Confirmed as specified. Two messages into one process: "remember the number 47"
then "what number did I give you?" — answered `47`, process alive throughout.

| | ms |
| --- | --- |
| cold start (spawn → first event) | 2335 |
| turn 1 (includes cold start) | 5900 |
| turn 2 (warm) | 2942 |

Keeping a process resident saves roughly **2.3s per message**. That is the
entire quantitative basis for ADR-0001's resident-process decision, and it
holds.

**Not anticipated:** `system/init` is re-emitted at the start of *every* turn,
not once per process. The process is genuinely persistent, but a wrapper that
treats `system/init` as "a new process started" will be wrong.

## Q2 — End-of-turn is unambiguous; mid-turn progress is not

**The end-of-turn signal is solid.** Every turn ends with a terminal `result`
event — one per turn, not one per process exit. It carries `stop_reason`
(`"end_turn"`), `terminal_reason` (`"completed"` / `"aborted_streaming"`), and
`is_error`.

`--replay-user-messages` works and is useful: our input comes back as a `user`
event with `isReplay: true` plus a `uuid` and `session_id`, which is enough to
correlate our messages to the stream.

**⚠️ Breaks ADR-0001's progress-reporting design.** During pure token
generation the stream goes **completely silent**. The gap measured here ran
10368ms, between `assistant`/thinking and the final message, against every other
gap in the run being under 3s. Tool-using turns emit events steadily; generating
turns emit nothing at all.

> **Corrected 2026-07-29 — 10368ms is a floor, not the maximum.** That gap was
> ended by this prototype's own interrupt, fired on a 15-second timer, not by the
> model; the turn ended `aborted_streaming` after 2881 characters. It measures how
> long the driver waited before cutting the turn off. The same prompt run to
> completion without the flag went quiet for **66747ms**, and that scales with
> output length, so it has no ceiling either
> (`docs/partial-messages-verification.md`, arm B). The finding below stands —
> generation is silent without the flag — but this document understated it by a
> factor of six.

ADR-0001 specifies "edit that same message in place (throttled to every 5–10s)
**as stream events arrive**". During a long generation no stream events arrive,
so the progress message would sit unchanged for longer than the throttle
interval it was designed around. **Fix:** add `--include-partial-messages`,
which is what actually produces incremental output.

**~~Validates ADR-0001's decision to decline stall detection.~~ Withdrawn
2026-07-29 — see below.** With no events during generation, "stalled" and
"thinking" are genuinely indistinguishable from the event stream. That decision
was asserted; it is now evidence-backed.

> **Why it is withdrawn.** The validation held only because this run was made
> without `--include-partial-messages` — the flag this same section prescribes as
> the fix. With it on, **0 of 207** mid-stream gaps in a 72-second generating turn
> exceeded 3s, worst **2641ms**, so silence during generation is no longer the
> signal this paragraph rests on. What survives is narrower and covers **tool
> execution only**. The decision to decline stall detection still stands; this
> measurement is no longer what backs it. The evidence that replaces it is in
> `docs/partial-messages-verification.md` (Q5c, and "The judgement ADR-0003 asked
> for"), and ADR-0003's "Progress reporting" carries the decision — including what
> that run still leaves unmeasured.

## Q3 — A turn can be stopped in-band without losing the session

**This resolves the question ADR-0001 flagged as never worked out, and the
answer is better than the ADR assumed.**

Sending the SDK control message over stdin:

```json
{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}
```

- `control_response` `{"subtype":"success","response":{"still_queued":[]}}` in **~20ms**
- the turn ends with `subtype: "error_during_execution"`, `terminal_reason: "aborted_streaming"`, `is_error: true`
- `[Request interrupted by user]` is injected into the transcript
- **the process stays alive** — same pid, and the very next message was served normally
- the aborted turn cost **$0.000625**

So `/stop` does **not** cost the warm process, and SIGTERM + `--resume` is not
needed for it. ADR-0001's premise that stopping a turn kills the resident
session is wrong in our favour.

**The SIGTERM path was verified anyway**, because ADR-0001's LRU eviction
depends on it: SIGTERM mid-turn exits **143** as documented, and a subsequent
`--resume` recovered the session with context intact (still answered `47`).
Eviction-and-resume is sound.

## Q4 — It bills to the subscription, and the failure mode is worse than described

**Subscription auth works.** `total_cost_usd` is populated — neither zero nor
absent. A `rate_limit_event` arrives carrying:

```json
{"status":"allowed","resetsAt":1785271200,"rateLimitType":"five_hour",
 "overageStatus":"rejected","isUsingOverage":false}
```

`rateLimitType: "five_hour"` is direct evidence that runs draw on the
subscription's rolling window rather than metered API billing. It also gives
ADR-0002's promised "expected reset time" a real source instead of a guess.

**⚠️ Breaks ADR-0001's audit record.** `total_cost_usd` is a **cumulative
session total**, not a per-turn figure. Across two turns `modelUsage` summed:
`inputTokens` 2 → 4, `outputTokens` 4 → 7, `cacheRead` 23684 → 55867. Only the
top-level `usage` object is per-turn.

ADR-0001 specifies "Per-task audit record: who, session, duration,
`total_cost_usd`". Logged as-is on a resident multi-turn process, the fifth task
in a session is recorded at the sum of tasks one through five. ADR-0002 leans on
that same figure for the monthly overflow cap and calls it "the number that
makes the eventual argument for or against moving fully to API billing" — built
on inflated values, that argument is made on bad data. **Fix:** diff consecutive
`total_cost_usd` values within a session, or compute from per-turn `usage`.

**The self-check has a real signal.** `system/init` carries `apiKeySource`:
`"none"` under the OAuth token, `"ANTHROPIC_API_KEY"` when a key is present.
That is what ADR-0001's startup self-check should assert on.

Note `claude auth status` **cannot** serve this purpose — it reports
`loggedIn: true` for any non-empty string, including a token that fails with 401
on first use. ADR-0001's choice of "a minimal `-p` invocation at boot" is
correct, and this is why.

### Negative test: the API key wins, and takes the model with it

Confirmed, exactly as ADR-0002 feared — with an aggravating factor it does not
mention. With both credentials in the environment:

```
apiKeySource="ANTHROPIC_API_KEY"   model=claude-opus-5[1m]
```

Under the OAuth token every run used `claude-sonnet-5`. The stray key silently
switched the model to **`claude-opus-5[1m]`** as well. ADR-0002 describes this
failure as a quiet conversion to metered billing; it is in fact a quiet
conversion to metered billing **on a substantially more expensive model**. The
unexpected invoice would be larger than the ADR's reasoning implies.

**⚠️ Sharpens ADR-0001's accepted concurrency risk.** The bad credential did not
fail fast. It produced **10 `api_retry` events across 182 seconds** — backoff
stretching to ~35s between attempts — before surfacing the 401. A single bad
credential therefore occupies a concurrency slot for **over three minutes**.
ADR-0001 accepts "three hung tasks exhaust the concurrency cap and halt the bot
entirely" as a risk requiring manual intervention; with a global cap of 3, a
misconfigured credential reaches that state on its own, without any task
hanging.

## Findings neither ADR anticipated

- **`bypassPermissions` is not unrestricted Bash.** `sleep 45` was refused:
  `<tool_use_error>Blocked: standalone sleep 45`. An independent guard layer
  exists beneath the permission mode. ADR-0001 states "All containment is at the
  container boundary" — that is not the whole picture, and the guards are
  undocumented enough that they should not be relied on either.
- **`is_error: true` co-occurs with `subtype: "success"`.** Seen on every auth
  failure. A wrapper keying on `subtype` alone will report failures as
  successes. Key on `is_error`.
- **The default model is `claude-sonnet-5`.** Neither ADR specifies a model,
  yet it is the dominant cost and capability variable — and, per the negative
  test, it changes with the credential.

## What should change

| ADR | Decision | Change |
| --- | --- | --- |
| 0001 | Progress reporting via stream events | Add `--include-partial-messages`; generation is otherwise silent |
| 0001 | Audit record logs `total_cost_usd` | Diff it per turn — the raw field is cumulative |
| 0001 | Startup self-check | Assert on `system/init.apiKeySource`; never on `claude auth status` |
| 0001 | `/stop` | Use the in-band `control_request` interrupt; the process survives |
| 0001 | "Containment is at the container boundary" | Qualify — a Bash guard layer also exists |
| 0001 | Concurrency cap of 3 | Bad credentials burn a slot for 3+ min; cap the retry storm |
| — | Model unspecified | Pin one explicitly |
