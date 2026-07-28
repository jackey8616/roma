# Verification: `--include-partial-messages` and the stall-detection assumption

Date: 2026-07-29
Claude Code **v2.1.220** (`darwin-arm64`, homebrew) — the same build as
`docs/headless-session-verification.md`, so the numbers below are directly
comparable to that document's.

ADR-0003 marks two claims as unverified and asks that they be run before the
progress-reporting design is built on them:

1. `--include-partial-messages` emits incremental output during pure token
   generation. This was inferred from the 10368ms silence measured *without* the
   flag, not from a run with it on.
2. Declining stall detection was justified by generation being silent — which is
   exactly what the flag removes. Whether a stalled turn is then distinguishable
   from a slow tool call was unknown.

This records what a runnable prototype did. Both are now measured; the second
answer is split rather than yes or no.

Method: three arms, run back to back, one fresh session each, driven by
`.scratch/proto/drivers/q5.mjs` on branch `prototype/headless-persistent-session`
(commit `728bd1b`). Isolation is the earlier run's:
`CLAUDE_CODE_OAUTH_TOKEN` only with `ANTHROPIC_API_KEY` absent, `CLAUDE_CONFIG_DIR`
and `CLAUDE_SECURESTORAGE_CONFIG_DIR` pointed at a scratch directory so no keychain
login is reachable, `cwd` outside the repo. Every raw event is captured.

Every capture this document cites is committed on that branch, including the
`q3-` and `q4-` ones from the earlier run — a correction whose evidence is not in
the repo cannot be checked.

| arm | flag | turn | capture |
| --- | --- | --- | --- |
| A | on | pure generation, no tools | `q5-A-gen-flag-on-96264fb0.jsonl` |
| B | **off** | the same prompt, verbatim | `q5-B-gen-flag-off-06bce022.jsonl` |
| C | on | one deliberately slow Bash call | `q5-C-tool-flag-on-c2ac815b.jsonl` |

Arm B exists so the comparison is not made across a day and a possible CLI
change. All three ran within four minutes of each other, on
`model=claude-sonnet-5` with `apiKeySource="none"`.

Gap statistics come from `q5-summary.json`, measured in the driver's event
handler; the `_t` timestamps inside the capture files are stamped a few
milliseconds earlier, inside the stream reader. Where the two disagree by under
20ms, that is the reason, not a second measurement.

## Q5a — The flag emits during generation. Claim 1 holds

Same prompt, same build, run back to back:

| | arm A (flag on) | arm B (flag off) |
| --- | --- | --- |
| events in the turn | **209** | **6** |
| max gap between events | **2641ms** | **66747ms** |
| p50 / p90 / p99 gap | 363 / 412 / 970ms | — (4 gaps) |
| gaps over 3s | **0** of 207 | 1 of 4 |
| turn duration | 72208ms | 69325ms |
| output | 17706 chars | 17093 chars |
| per-turn cost | $0.108348 | $0.092103 |

Arm A delivered the essay as **194 `text_delta` chunks** — mean 91.3 characters,
min 5, max 164, summing to exactly the 17706 characters of the final message.
Only two gaps in the whole run exceeded one second: 1426ms *before* the first
token, between `system/status` and `rate_limit_event`, and the 2641ms one at
+51803ms, mid-essay.

Arm B produced the whole essay in a single `assistant` event at +69290ms, after
**66734ms** in which the stream carried nothing at all.

**The 5–10s progress throttle has something to throttle.** The longest a
renderer would have waited for new content during generation was 2641ms, against
a throttle interval of 5000ms — every scheduled update had fresh text.

**The final result is unaffected.** With the flag on, the complete assistant
message still arrives as one `assistant` event carrying all 17706 characters, at
+72098ms — 85ms before the terminal `result`. ADR-0003's rule that the final
result is posted as its own message can be served from that event; the deltas are
for the progress message only.

### ⚠️ The 10368ms figure is a floor, not a maximum

`docs/headless-session-verification.md` Q2 and ADR-0003's "Driving Claude Code"
both quote **10368ms** as the measured maximum silence. Re-reading the capture it
came from (`q3-d6dcfbe4.jsonl`), that gap runs from the `assistant`/thinking event
at +2850ms to a `control_response` at +13217ms — **the prototype's own interrupt**,
fired on a 15-second timer by `drivers/q2q3.mjs`. The turn ended
`error_during_execution` / `aborted_streaming` after 2881 characters. (By the
capture's own timestamps the gap is 10367ms; the 10368ms on record was measured
one millisecond later in the driver's handler, the same skew noted above.)

So 10368ms is how long that driver waited before cutting the turn off. It is not
how long generation stays silent. Run to completion, the same prompt without the
flag went quiet for **66747ms** — and that is a function of output length, so it
has no ceiling either. The correction makes the flag more load-bearing than the
number in ADR-0003 implies, not less.

## Q5b — What the flag adds

**One new top-level event type: `stream_event`.** It wraps the raw Anthropic SSE
event under `.event`; everything else in the stream is unchanged. Shapes observed
across arms A and C:

| `.event.type` | `.delta.type` / `.content_block.type` | carries |
| --- | --- | --- |
| `message_start` | — | `.message.model`, `.message.usage` |
| `content_block_start` | `thinking` \| `text` \| `tool_use` | `.index`, the empty block |
| `content_block_delta` | `text_delta` | **`.delta.text`** — the prose a renderer shows |
| `content_block_delta` | `thinking_delta` | `.delta.thinking` (**empty**), `.delta.estimated_tokens` |
| `content_block_delta` | `signature_delta` | thinking-block signature |
| `content_block_delta` | `input_json_delta` | `.delta.partial_json` — tool input, assembled in pieces |
| `content_block_stop` | — | `.index` |
| `message_delta` | — | `.delta.stop_reason`, cumulative `.usage` |
| `message_stop` | — | — |

Every `stream_event` also carries `session_id`, `uuid` and `parent_tool_use_id`,
so events can be attributed across a pool of concurrent sessions.

**Thinking is observable but not readable.** `thinking_delta` arrived with
`"thinking": ""` and an `estimated_tokens` count; the text is not in the stream.
A renderer can say that thinking is happening and roughly how much, never what.
`system/thinking_tokens` carries the same running estimate as its own event.

**Two event types are not the flag's.** `system/task_started` appears in
`q3-fd218a22.jsonl` and `system/thinking_tokens` in `q4-edeca40a.jsonl`, both
captured before the flag existed in this prototype. Do not attribute them to it.

**One correlation, offered as a correlation.** `system/status`
(`{"status":"requesting"}`) appeared only in the flag-on arms — once in A, twice
in C — and in none of arm B or the four earlier flag-off captures. That is
suggestive, not a mechanism; nothing here establishes that the flag causes it.

## Q5c — What a slow tool call looks like

Arm C, one Bash call chosen to take about 30 seconds. `sleep` is refused by the
guard layer the earlier run found (`Blocked: standalone sleep 45`), so this burns
CPU instead: `awk 'BEGIN{s=0; for(i=0;i<600000000;i++) s+=i; print s}'`.

| offset | event | gap |
| --- | --- | --- |
| +2036ms | `stream_event/content_block_start/tool_use` | 2ms |
| +2036…2559ms | 5 × `input_json_delta` assembling `{"command": "awk …", "timeout": 60000}` | ≤277ms |
| +2560ms | `assistant` — full `tool_use(Bash)` message | 1ms |
| +2583ms | `stream_event/message_stop` | 0ms |
| +6536ms | `system/task_started` — `task_id`, `tool_use_id`, `description` | 3953ms |
| **+31875ms** | `system/task_notification` — `status: "completed"` | **25339ms** |
| +31900ms | `user` — `tool_result` `179999999467108928` | 25ms |
| +33366…33574ms | 2 × `text_delta` | ≤208ms |
| +33609ms | `result` — `is_error=false`, 33683ms, $0.041665 | 16ms |

Within one turn, with the flag on throughout: **25352ms of silence while the tool
ran, against a 208ms maximum while the model generated.** The two phases do not
look remotely alike.

## The judgement ADR-0003 asked for

**Is a stalled turn distinguishable from a working one with the flag on? Split.**

**During generation — yes, now.** Silence during generation has become anomalous.
Across 207 mid-stream gaps in a 72-second generating turn, none exceeded 3s and
the largest was 2641ms. A generating turn that emits nothing for tens of seconds
is not a shape this run produced.

**During tool execution — no.** The stream marks the tool starting and then says
nothing until it is done: in arm C, `system/task_started` at +6536ms, then 25339ms
of silence before `system/task_notification` reported completion. Nothing arrives
*while* the tool runs, and that duration has no upper bound: 25.3s for a CPU spin,
minutes for a build or a test suite. A stalled tool call and a slow one are the
same signal, and no threshold separates them without also killing legitimate work.

**But the wrapper always knows which of the two it is in.** The last event before
the silence says so. A gap after `text_delta` is generation. A gap after the
`assistant` message carrying `tool_use`, or after `system/task_started`, is a tool
running — and `task_started` names it in `description`, so a progress message can
show *what* is running through a window where nothing else arrives.

**What this does to ADR-0003's decision.** The decision to decline stall detection
can stand, but not on the evidence it currently cites. This sentence in
`docs/headless-session-verification.md` Q2 —

> With no events during generation, "stalled" and "thinking" are genuinely
> indistinguishable from the event stream. That decision was asserted; it is now
> evidence-backed.

— is false under the flag, and it is the only measurement behind ADR-0003's
"Stall detection stays declined". What survives is narrower and should replace it:
a stalled *tool call* is indistinguishable from a slow one. Generation is no
longer the reason.

## What should change

| Where | What it says now | Change |
| --- | --- | --- |
| ADR-0003, Driving Claude Code | "`--include-partial-messages` … the flag itself has not been run … Verify it before the first deploy" | Run. 209 events vs 6, max gap 2641ms vs 66747ms on the same prompt. Drop the caveat. |
| ADR-0003, Driving Claude Code | "measured maximum gap **10368ms**" | A floor, not a maximum — that turn was interrupted at 13.2s. Same prompt to completion: **66747ms**, and it scales with output length. |
| ADR-0003, Progress reporting | throttled to every 5–10s from partial-message events | Holds. Longest wait for new content during generation: 2641ms. |
| ADR-0003, Progress reporting | "Stall detection stays declined … should be re-examined against a run with the flag on" | Re-examined. Decision stands; the supporting evidence must be restated as tool-execution-only. |
| `docs/headless-session-verification.md` Q2 | "Validates ADR-0001's decision to decline stall detection" | Withdraw as written — true only during tool execution now. |
| Spec #1, `ProgressReporter` | built against partial-message events | Field names are now known: `stream_event.event.delta.text` for prose, `system/task_started.description` for the tool window, the final `assistant` event for the result. |

None of these are edits this document makes. ADR-0003 and the Q2 section above
are left as they stand, to be reconciled deliberately.

## Limits of this run

- **n = 1 per arm, one prompt.** 2641ms is the largest gap in a single 72-second
  generating turn, not a distribution. A stall threshold set from this number
  alone would be set from one sample.
- **Long thinking phases are uncharacterised.** Measured `content_block_start` to
  `content_block_stop`, arm A's thinking block lasted **14ms** and arm C's
  **372ms**. Whether a 30-second extended-thinking phase
  streams `thinking_delta` steadily or goes quiet is not measured here, and it is
  the obvious remaining hole in "generation is no longer silent".
- **`system/task_notification` was seen only under the flag**, but the one
  flag-off capture with a tool call (`q3-fd218a22.jsonl`) had that call complete
  in 2ms, so its absence there says nothing.
- One machine, one model, one CLI build. Behaviour is version-specific; re-run
  before any upgrade.
- The three arms drew **$0.242** on the Shared Window.
