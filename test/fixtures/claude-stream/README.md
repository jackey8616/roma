# Recorded `claude -p` streams

Real Claude Code output, captured by the prototype on branch
`prototype/headless-persistent-session` against **Claude Code v2.1.220**
(`darwin-arm64`), under a Shared Window credential. They are copied here
unedited — same bytes, new filenames.

They are fixtures rather than hand-written doubles for two reasons. The events
are real, so a test asserting against them is asserting against the actual
contract; and re-running them costs real money on the Shared Window (a full q5
run drew roughly $0.24), so a capture is worth keeping.

Each line carries a `_t` field the prototype added on arrival — the wall-clock
time the event reached the driver. It is not part of the stream, and
`recordedStream()` strips it before anything sees it. It is left in the files
because the inter-event gaps quoted in `docs/partial-messages-verification.md`
are computed from it.

| file | from | driver | what it caught |
| --- | --- | --- | --- |
| `three-turns-one-process.jsonl` | `q4-edeca40a.jsonl` | `q4.mjs` | Three Turns in one process. `system/init` at the head of each. `total_cost_usd` climbing 0.0103129 → 0.0103129 → 0.0123081, which is what makes it a Session total rather than a Turn cost. |
| `auth-failure.jsonl` | `q4-d1095d53.jsonl` | `q4.mjs` | A 401 under a stray `ANTHROPIC_API_KEY`, arriving as `is_error: true` **with** `subtype: "success"`. Also the ten `api_retry` events over 182s that the retry-storm cap exists for, and `apiKeySource: "ANTHROPIC_API_KEY"` with the model silently moved to `claude-opus-5[1m]`. |
| `interrupted-turn.jsonl` | `q3-d6dcfbe4.jsonl` | `q2q3.mjs` | An in-band interrupt: `control_response` in ~20ms, the Turn ending `error_during_execution` / `aborted_streaming` having spent $0.000625, and the same process serving the next Turn. |
| `tool-use-turn.jsonl` | `q3-fd218a22.jsonl` | `q2q3.mjs` | A tool-using Turn, including `system/task_started`. |
| `generation-partial-messages.jsonl` | `q5-A-gen-flag-on-96264fb0.jsonl` | `q5.mjs` | A 72-second pure-generation Turn with `--include-partial-messages` on: 209 events, worst gap 2641ms, and the complete 17706-character answer arriving *again* as its own `assistant` event before the terminal result. |
| `generation-no-partial-messages.jsonl` | `q5-B-gen-flag-off-06bce022.jsonl` | `q5.mjs` | The control for the above, same prompt with the flag off: 6 events, the whole answer after 66747ms of dead stream. |
| `tool-use-partial-messages.jsonl` | `q5-C-tool-flag-on-c2ac815b.jsonl` | `q5.mjs` | A tool-using Turn with the flag on — 25339ms of silence while the tool ran, against a largest generating gap of 208ms. |
| `readout-context.jsonl` | captured for ADR-0012 | — | A Readout: `/context` with the Caller Marker written *after* it, relayed exactly as roma relays one. `num_turns: 0` and `total_cost_usd: 0` — the command answered locally and the model was never called — with the command's own output as `result`. What the marker-first version does instead is a real Turn at $0.0549, which is the fault ADR-0012 exists to fix. |
| `compaction-auto.jsonl` | captured for #98 | — | An auto-Compaction, on stdout: `system/compact_boundary` with `compact_metadata.trigger: "auto"`, 61486 tokens in and 1375 out over 19487ms. Also the cost claim #98 rests on, in one file — two byte-identical `OK` messages, the quiet one $0.0186 over 1 turn, the one the Compaction landed inside $0.0917 over 2. And a `compact_result: "failed"` (`too_few_groups`) *earlier in the same run*, during a healthy Turn, which is why "failed therefore dead" is not a rule roma can use. |
| `compaction-failed.jsonl` | captured for #98 | — | The same failure on its own, provoked with the threshold under the floor: `system/status` carrying `compact_result: "failed"` and `compact_error: "too_few_groups"` — a code rather than the error text. The Session then served the next Turn normally at $0.0104. |
| `resume-lost.jsonl` | captured for #105 | — | What `--resume` at a Session with no Transcript answers with **on stdout**: one terminal `result`, `error_during_execution`, `is_error: true`, `num_turns: 0`, `total_cost_usd: 0`, the reason in an `errors` array, and no `result` field beside it. The same refusal under plain `claude -p` is a line on stderr and an empty stdout, which is how every earlier measurement of it was taken — and why the pool's `resume-lost` recovery never fired in production until #105. The `errors` array is what tells this apart from `auth-failure.jsonl`, which carries its sentence in `result` and no `errors` at all. |

`tool-use-turn.jsonl` and `generation-no-partial-messages.jsonl` are not
exercised by any test. They are the flag-off world, which roma does not run in —
kept as the control the flag-on captures are read against, and because
regenerating them means spending the Shared Window again.

The two `compaction-*.jsonl` captures did not come from the prototype either.
They were taken by `src/compaction.live.test.ts` — the seam 2 test that produced
them is in the repository and can be run again, so they are the first captures
here that are reproducible rather than only kept. Raw stdout was teed to disk on
the way past rather than re-serialised from parsed events, because a fixture that
went through `JSON.parse` is one somebody has to take on trust. They carry no
`_t`, for the same reason `readout-context.jsonl` does not.

One thing to know before reading them: **the auto-compact threshold was shrunk**,
with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, from 967k to roughly 40k in one and to
roughly 10k in the other. A Compaction at a shrunk threshold is a Compaction and
the events are the real ones, but nothing in them is evidence about when a real
Compaction fires, how long a full-size one takes, or what it preserves.
`docs/compaction-verification.md` is the run.

`readout-context.jsonl` is the one capture that did **not** come from the
prototype's mac. It was taken in a Claude Code cloud container on the same
pinned build, driving the same invocation roma spawns — `-p --input-format
stream-json --output-format stream-json --verbose --include-partial-messages
--replay-user-messages --session-id`, with the message written to stdin as a
`{type:'user'}` frame — and it is unedited like the rest. Two consequences worth
knowing before reading it: it carries no `_t`, because that field was the
prototype driver's and this was captured by piping stdout; and its
`system/commands_changed` event is 15KB of *that container's* skills and MCP
tools, which roma's own container does not have. Nothing roma reads comes from
either, and it is left in because editing a capture is how a fixture stops being
evidence.

This is also the only capture that cost nothing to take, which is the whole
point of it: a Readout drives no Turn.

`resume-lost.jsonl` is the second one that cost nothing, for a different reason:
a `--resume` the CLI cannot honour exits before it calls anything, which is also
why the failing Session in #105 retried for free. It was taken in a Claude Code
cloud container on the pinned build, under the invocation roma spawns —
`--permission-mode bypassPermissions` included, which meant creating a non-root
user to run it, since the CLI refuses that flag as root. stdout was redirected
to the file and is unedited; the session id in it is the throwaway uuid the
capture pointed `--resume` at, and no Transcript for it has ever existed. Its
stderr is not kept here, but it carried the familiar
`No conversation found with session ID: …` — the point of the capture is that
stdout carries the refusal *as well*, which is the half nothing had looked at.

Behaviour is version-specific. A capture is evidence about v2.1.220 and nothing
else; re-verify before the pinned version moves.
