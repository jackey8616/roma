# Verification: what a Turn adds to the Transcript

Date: 2026-08-01
Claude Code **v2.1.220** — the ADR-0007 pin, so the numbers are comparable with
`docs/transcript-collision-verification.md`, which measured the only other real
Transcript this repository has seen.

#41 is an accepted cost rather than a defect: ADR-0006 has roma delete nothing
from `ROMA_CLAUDE_CONFIG_DIR`, and the operator who names that directory needs to
know how fast it grows. The figure the ticket carried was an extrapolation from
the wrong artefact — a recorded **stdout** stream, 202 of whose 209 events are
the `stream_event` deltas `--include-partial-messages` writes to stdout, with
nothing establishing that any of them reach the file on disk. #41 says what is
needed instead in as many words:

> It does not need a long run. It needs one run and two `wc -c`s.

This records that run.

Method: `src/transcript-growth.live.test.ts`, a seam 2 test — a real `claude -p`
on the Shared Window, driven through `ClaudeSession` on roma's own invocation
path. Unlike the earlier verification documents this one has a committed test
behind it rather than a throwaway driver, so the run is repeatable with
`npm run test:seam2`. **$0.183330** for the run recorded here.

Two Tasks of the same shape on **one Session**, so the per-Turn delta separates
from the per-Session overhead: write three small files with three `Write` calls,
read all three back, reply; then add a method to one of them, update the other
two, and read all three back again. Both were told to run no shell commands, so
the Turns differ from each other only in `Write` versus `Edit`.

## The measurement

| | bytes | lines | cost | stdout events | tools |
| --- | --- | --- | --- | --- | --- |
| after Turn 1 | 35,543 | 23 | $0.113787 | 99 | `Write ×3`, `Read ×3` |
| after Turn 2 | 63,365 | 40 | $0.069543 | 84 | `Edit ×3`, `Read ×3` |

- **Per Turn: 27,822 bytes over 17 lines** — about 1.6 kB a line
- **Per Session, one-off: 7,721 bytes** — what is left of Turn 1 once a Turn's
  own cost is taken out of it, and it is charged once however long the
  Conversation lives
- **At a hundred Tasks a day: 1.02 GB a year**, plus 7,721 bytes for every
  Session ever started

Read 27.8 kB as "a Task of about this size" rather than as a deployment's mean.
This is one Task shape, and it writes and reads three small files, so its
Transcript carries their contents roughly twice over. The 7,721-byte per-Session
figure is the sturdier of the two — it is one Session's fixed records rather than
a sample of a distribution nobody has.

## What it corrects

- **The 1.5 GB/year analogue was the right order of magnitude and about 50%
  high.** ADR-0005 called it "an order of magnitude and nothing finer" and that
  was the right amount of confidence to have in it. The measured figure is
  1.02 GB a year at the same hundred Tasks.
- **"14,089 bytes probably overstates a Turn's marginal cost" was right, and it
  also understates a real Task by about half.** The one-off records are 7,721
  bytes, so that trivial Turn's own marginal cost was around 6.4 kB. One
  tool-using Turn is roughly 2× the entire trivial-Turn Transcript.
- **Per message rather than per delta is now measured rather than inferred.**
  99 stdout events produced 23 transcript lines; 84 produced 17. The
  `--include-partial-messages` deltas do not reach the file, which is what
  ADR-0005 inferred from seven lines and one Turn.

## The wrinkle worth keeping

The Transcript was found under a slug of the process's **physical** working
directory — `getcwd` after the `chdir` — while the path handed to the process was
a `/var` symlink to it. `docs/transcript-collision-verification.md` Q1 says
"slug-of-absolute-cwd", which is true exactly when that path contains no symlink;
that document's own run had none.

Nothing reads the Transcript today (ADR-0005, ADR-0006), so this is not a bug. It
is a trap for the reclamation #41 is about: code that maps a Session's cwd to its
Transcript has to resolve the path first, or it looks in a directory that does
not exist and concludes there is nothing to reclaim. The test locates the file by
its name — the Session id, which is unambiguous — and then asserts the directory,
accepting either spelling, so the mapping is pinned without pinning which of the
two paths Claude Code happens to slug.

## What is asserted, and what is not

The test asserts where the file lands, that both Turns really used tools, and
that the second Turn grows the file. The sizes are logged in `afterAll` and
deliberately not asserted: a test that went red because a Turn came out 8% larger
would be measuring the model's mood, and the number belongs in a document — this
one — rather than in an expectation. Logging in the hook so a run that spent the
money leaves the reading behind even when an assertion is what failed.

## What this does not answer

- **A retention window.** ADR-0006 declined to reclaim the Transcript on a timer
  because the number it needs — how long an operator might want to reconstruct a
  Task after the fact — is a question no deployment has been alive long enough to
  answer. A growth rate is not that number, and #41 stays open.
- **What a deployment's Tasks actually look like.** One shape, measured twice.
  A Task that reads a large repository rather than three files it just wrote
  would land somewhere else entirely.
- **Whether the format is stable across CLI versions.** Measured once, on the
  pinned build. Claude Code is free to change what it writes, which is part of
  why ADR-0006 has roma read none of it.
