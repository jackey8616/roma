# PROTOTYPE — persistent headless `claude -p`

**Throwaway.** Keep the answers, delete the code. Brief:
`.scratch/prototype-brief-headless-persistent-session.md`.

## The question

ADR-0001 and ADR-0002 both rest on an assumption verified only from docs and
`--help` output: *a long-lived `claude -p` process, fed over stream-json,
authenticating with a personal subscription token, behaves as the docs
describe.* This prototype makes that assumption runnable so it can be checked.

The state model under test is the one a bridge would need to keep: **one
resident process per session, with a turn-level view of it** — is it idle or
thinking, when did a turn actually end, what did it cost, and what happens to
the session when you try to stop a turn. `session.mjs` is that model; `tui.mjs`
is a throwaway shell for driving it by hand.

## Run

```bash
node .scratch/proto/tui.mjs
```

Requires `.scratch/proto/.env` containing `CLAUDE_CODE_OAUTH_TOKEN=…`
(from `claude setup-token`). Pinned to CLI **v2.1.220** — behaviour may differ.

## Drivers

Unattended runs, one per question. Each writes its raw events beside this file —
`q3-<id>.jsonl` and `q4-<id>.jsonl` for the earlier drivers,
`q5-<arm>-<id>.jsonl` for `q5.mjs`. Those captures are committed, against the
`.scratch/` ignore rule, because the findings documents quote them and re-running
them costs real money.

| driver | question | findings |
| --- | --- | --- |
| `drivers/smoke.mjs` | does a process spawn and answer at all | — |
| `drivers/q2q3.mjs` | event density during a long turn; in-band interrupt | `docs/headless-session-verification.md` |
| `drivers/q4.mjs` | SIGTERM + `--resume`; stray `ANTHROPIC_API_KEY` | `docs/headless-session-verification.md` |
| `drivers/q5.mjs` | does `--include-partial-messages` emit during generation; is a stall distinguishable | `docs/partial-messages-verification.md` |

`q5.mjs` runs three arms back to back and writes `q5-summary.json`: generation
with the flag, the same prompt without it as a control, and a tool-using turn
with the flag. A full run draws roughly $0.24 on the Shared Window.

## Isolation

- `CLAUDE_CONFIG_DIR` / `CLAUDE_SECURESTORAGE_CONFIG_DIR` →
  `.scratch/proto/claude-home/`, so the spawned process cannot reach the
  machine's keychain login. This mimics the container, where no keychain exists.
- `cwd` → `.scratch/proto/work/`, so the repo's `CLAUDE.md` isn't picked up.
- Every raw stream event is appended to `events-<id>.jsonl` for Q2.

## Keys

| key | does | question |
| --- | --- | --- |
| `1` | send "Remember the number 47" | Q1 |
| `2` | send "What number did I give you?" | Q1 |
| `3` | send a long turn (`sleep 30` via Bash) | Q2, Q3 |
| `t` | type a free-text prompt | — |
| `i` | in-band `control_request` / `interrupt` over stdin | Q3 |
| `k` | SIGTERM the process | Q3 |
| `r` | respawn with `--resume` | Q3 |
| `c` | respawn cold with the same `--session-id` | Q1 |
| `x` | toggle a bogus `ANTHROPIC_API_KEY` and respawn | Q4 |
| `d` | close stdin (EOF) | Q2 |

## What to watch

- **cold start vs turns** — the whole justification for resident processes.
- **`state` returning to IDLE** — driven by a `result` event. If that only
  arrives at process exit, the progress design breaks.
- **`silence`** — long gaps mean a stall detector has nothing to read.
- **`total_cost_usd`** — rendered `ABSENT` in red if the field is missing under
  subscription auth. The audit-log design assumes it is meaningful.
- After `i` or `k`: does the process survive, and does `r` come back clean?
