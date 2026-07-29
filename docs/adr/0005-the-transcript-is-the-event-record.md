# 5. The Transcript is the event record

Date: 2026-07-29

## Status

Accepted. Narrows the spec in #1 and closes #33 without building it.

**Amended 2026-07-29**, in the way ADR-0002 and ADR-0003 were: the decision is
unchanged and what the amendment corrects is the evidence beneath it. The size
figure measured a recorded stdout stream and called it a Transcript. Correcting
it makes the argument that rested on it stronger rather than weaker, which is
why nothing else here moves. Amendments are marked inline.

## Context

#1 carries thirty-eight user stories. An audit of all of them against the code
and the tests found thirty-seven implemented and one with nothing behind it:

> 34. As an operator, I want every Claude Code event recorded, so that I can
> reconstruct what happened in a Task after it has finished.

Only two places in `src/` write to disk — `audit-log.ts`, one line per Task, and
`session-generation.ts`, one integer. `SessionPool` re-emits every event tagged
with the Session it came from, so the events reach `serve.ts` and are then
dropped.

What the audit also found is that the events are on disk already, and always have
been. `buildEnv` points `CLAUDE_CONFIG_DIR` at `ROMA_CLAUDE_CONFIG_DIR`, and that
is where Claude Code keeps the Transcript that `--resume` reads. ADR-0003 rests on
that file existing; it names it ten times and each time to say it is not ours.

So the question was never "record the events or lose them". It was whether roma
should write a **second** copy of something it already causes to be written.

Two facts sized the choice, both measured rather than assumed:

- **Volume is not the objection.** `test/fixtures/claude-stream/generation-partial-messages.jsonl`
  is 112,874 bytes for 209 events — one 72-second Turn producing 17,706 characters.
  At a hundred Tasks a day that is about 4 GB a year. The ticket had listed
  unbounded growth as a reason for caution and it was wrong.

  **Amended — the figure is smaller than that, because it measured the wrong
  file.** That fixture is a recorded *stdout stream*, and 202 of its 209 events
  are `stream_event`: the per-token deltas `--include-partial-messages` writes to
  stdout. The Transcript is a different file, under
  `$CLAUDE_CONFIG_DIR/projects/`, and nothing establishes that the deltas reach
  it — `docs/transcript-collision-verification.md` measured a real one at 14,089
  bytes over **seven lines** for a trivial Turn, where the same Turn's stdout
  would run to dozens. It is written per message, not per delta. The nearest
  honest analogue in the fixtures is `generation-no-partial-messages.jsonl` at
  40,761 bytes, or about 1.5 GB a year at the same hundred Tasks — still a stream
  and not a Transcript, so an order of magnitude and nothing finer. The decision
  is untouched: this is the argument's own direction, only further along. Nobody
  has yet measured the artefact that actually matters, which is #41.
- **`ROMA_CLAUDE_CONFIG_DIR` was optional.** Unset, `CLAUDE_CONFIG_DIR` is not set
  at all and `HOME` is on `buildEnv`'s passthrough list, so the Transcripts of
  every Session land in the host user's `~/.claude/projects/`, interleaved with
  whatever Claude Code that person runs themselves — in a directory roma never
  reclaims.

## Decision

**roma writes no record of Claude Code events. The Transcript is that record.**

Three artefacts, one question each, and the boundaries are the point:

| | answers |
| --- | --- |
| **Audit Record** | who asked, how long they waited, what it cost, which credential paid |
| **Operator Log** | what roma decided, and why, as it happened |
| **Transcript** | what the agent actually did |

Story 34 is dropped from #1 rather than left unmet. Both new terms are in
`CONTEXT.md`, because a decision whose whole content is "which artefact answers
which question" cannot be written down while two of the three are unnamed.

**`ROMA_CLAUDE_CONFIG_DIR` becomes required** — #34, built in #37. The decision
above leans on the Transcript being somewhere known, and that cannot rest on a
variable a deployment may omit. Making it required also turns ADR-0002's isolation
from a promise conditional on configuration into an unconditional one: there is no
longer a way to start roma whose Claude Code processes resolve credentials against
the host's keychain.

Required all the way down rather than only in `env-config.ts`, which is the one
judgement call #34 left open. `buildEnv` is driven directly by tests as well as
by `startRoma`, so an optional parameter there would have kept a way to break
both promises that the type did not mention — at the cost of a few test call
sites naming a directory, which they should have been doing anyway.

## Consequences

- **A deployment that omitted the variable is refused at startup**, by the same
  configuration refusal that names everything missing at once. That is a breaking
  change to the environment contract, taken now because roma has no real
  deployment yet and the same change costs far more later.
- **The Transcript is now load-bearing and still unbounded.** Nothing reclaims it.
  ADR-0003's Isolation section already carries this as a known hole — reclaiming a
  working directory forgets a Session exists while its Transcript survives, and
  what the CLI does with `--session-id` at an id it already has a Transcript for
  has never been run.
- **That hole may now be closeable, which it was not when ADR-0003 accepted it.**
  ADR-0003 accepted it because the alternative was "a second record of which
  sessions exist, kept outside the directory it describes". If the Transcript were
  reclaimed *alongside* the working directory, no second record is needed — the
  two go together and "reclaiming the directory forgets the Session" becomes true
  rather than half-true. That would also reopen the in-place session reset this
  ADR's predecessor rejected for `/new`. **Deliberately not decided here** — it is
  #35, because getting it wrong deletes somebody's context.
- **An operator reconstructing a Task reads a Session's Transcript, not a Task's.**
  A Session serves many Tasks over its life, so the slice belonging to one Task
  has to be found — the Audit Record gives the Session and the timings to find it
  with. Nobody has done this in anger yet.

## Alternatives considered

**Build it: a per-Task event record roma owns, with its own retention.** Rejected.
It is a second copy of bytes already on disk, and the need it serves — reconstruct
one Task — is served by the Transcript plus the Audit Record's Session id and
timings. Volume was not the reason; duplication was.

**Adopt the Transcript: leave it as the only copy, but make its retention and
reclamation roma's responsibility.** Rejected *for now* rather than outright. It
is the appealing middle, and it collides head-on with `--resume`: roma cannot bound
the lifetime of the file the resume mechanism depends on without deciding when a
Session stops being resumable. That is the ticket above.

**Say nothing and simply not implement story 34.** Rejected. The spec would carry
an unmet story that no sub-issue ever covered, and the next reader would find the
gap by accident rather than by reading that it was a choice.
