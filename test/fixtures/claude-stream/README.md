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

`tool-use-turn.jsonl` and `generation-no-partial-messages.jsonl` are not
exercised by any test. They are the flag-off world, which roma does not run in —
kept as the control the flag-on captures are read against, and because
regenerating them means spending the Shared Window again.

Behaviour is version-specific. A capture is evidence about v2.1.220 and nothing
else; re-verify before the pinned version moves.
