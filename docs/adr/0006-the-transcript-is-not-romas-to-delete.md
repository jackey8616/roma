# 6. The Transcript is not roma's to delete

Date: 2026-07-29

## Status

Accepted. Upholds ADR-0003's sentence rather than overturning it, and closes #35.

Supersedes nothing. ADR-0005's consequence "that hole may now be closeable" is
answered here: it is closed, but by #40 rather than by reclamation.

## Context

ADR-0003 carried a known hole in its Isolation section:

> **Reclaiming a working directory also forgets that the session exists** […] the
> transcript `--resume` needs belongs to Claude Code and is not ours to delete —
> so a conversation that goes quiet for more than 7 days and then comes back is
> spawned with `--session-id` at an id that may still have a transcript. **What
> the CLI does with that is unmeasured.**

ADR-0005 then made `ROMA_CLAUDE_CONFIG_DIR` required (#34), so roma names the
directory the Transcript lives in — the first time it has been in a position to
reclaim one at all — and raised the question as #35.

**The behaviour is now measured** (`docs/transcript-collision-verification.md`,
Claude Code v2.1.220). Six findings, and two of them decide this:

- **`--session-id` at an id whose Transcript survives is refused outright** —
  `exit 1`, `Error: Session ID … is already in use.`, before any stream event.
  Since `session-pool.ts` picks the flag from `existsSync(cwd)` alone, a
  Conversation that outlives the reclaim is **permanently unservable** today. The
  hole was not an uncertainty; it was a defect.
- **`--resume` reaches that same Session, and it has forgotten nothing.** Working
  directory deleted and recreated empty, Transcript untouched: the process comes
  up clean and still remembers. Nothing about the reclaim damages the Session —
  only roma's *reading* of whether it exists.

That second finding is what changed the decision. ADR-0005 reasoned that if the
Transcript were reclaimed alongside the working directory, "no second record is
needed — the two go together and 'reclaiming the directory forgets the Session'
becomes true rather than half-true". That is still correct. But reclaiming is no
longer the only thing that closes the hole, and it is by far the more
destructive.

## Decision

**roma names the directory the Transcript lives in, reads nothing out of it, and
deletes nothing from it.** ADR-0003's sentence stands.

The hole is closed by **#40** instead: the pool recovers from a refused
`--session-id` by reaching the Session with `--resume`, mirroring the
`resume-lost` handler that already exists for the opposite failure. That restores
the Conversation *with its Transcript*, which reclamation could not have done —
it would have restored service by destroying the record it was restoring access
to.

Three consequences of #35 fall away with it, unasked:

- **What guards a Parked Task.** Nothing is deleted, so nothing needs guarding.
- **Whether `session-generation.ts` survives.** It does. In-place reset was only
  viable if the Transcript were deleted first — `--session-id` is refused while
  one exists — so `/new` keeps rotating the generation, and its 141 lines stay.
- **Whether `/new` should orphan a Transcript immediately.** It should, and it
  already does. #35 raised this as the sharper case than the idle one, and it is
  — but it sharpens the argument *against* deleting rather than for it: rotating
  a generation strands a Transcript within seconds of somebody choosing to start
  again, so a rule that reclaimed stranded Transcripts would destroy the record
  of the Session they had just stepped away from, while they were still in the
  room. Orphaning is the right behaviour; collecting the orphans is not.

`src/transcript-lifetime.test.ts` keeps the decision by reading the sources, in
the idiom `provisioning.test.ts` uses. It is an **allowlist**: only the three
files that build a process environment — `env-config.ts`, `build-env.ts`,
`startup.ts` — may name a config directory at all, and none of them may join,
read or delete anything under one. Nothing can remove what it cannot name, so the
naming is what is policed; searching for path-building idioms instead would be a
guard with a gap in it, since `join`, `resolve`, `+ '/'` and a template literal
are all the same intent.

It does **not** forbid deletion. `session-pool.ts` deletes working directories on
the reclaim timer and `startup.ts` deletes the self-check's probe directory; both
are right, and a rule that flagged them would be switched off within a week.

## Consequences

- **The Transcript grows without bound, and nothing reclaims it.** This is the
  cost, taken deliberately. ADR-0005 measured roughly 4 GB a year at a hundred
  Tasks a day, and that figure is now a commitment rather than an observation.
  Filed as #41 rather than left implicit — an operator needs to know the
  directory they name in `ROMA_CLAUDE_CONFIG_DIR` only ever gets larger.
- **Ownership stayed where ADR-0003 put it, and the reason improved.** ADR-0003
  said "not ours" and rested on it being Claude Code's file. That is still true,
  but the sharper reason is now available: the Transcript is the only account
  there is of what an agent did (ADR-0005), so deleting one destroys evidence
  that cannot be reconstructed, in exchange for disk that is cheap.
- **A Conversation is never lost to the reclaim.** Its working directory goes
  after seven idle days and its Transcript does not. Whether that asymmetry is
  surprising to an operator is untested — nobody has watched a Conversation come
  back from a fortnight's silence in anger.
- **The decision is reversible in the direction that matters.** Choosing not to
  delete keeps every option open; choosing to delete would not have. If unbounded
  growth becomes the pressing problem, reclamation can be decided then, with a
  real deployment's numbers instead of an estimate.

## Alternatives considered

**Reclaim the Transcript with the working directory, at the same seven-day mark.**
Rejected. It was the appealing option while the hole looked like it needed
closing from this side — and #40 closes it without deleting anything. What
remained was a proposal to destroy the only record of what an agent did in order
to reclaim disk, on a schedule tuned for working directories rather than for
evidence, with a Parked Task able to sit for hours inside the window. The
`/new`-orphans-immediately case would have sharpened that: rotating a generation
strands a Transcript at once, so the same rule would delete the record of a
Session somebody had used `/new` on minutes earlier.

**Reclaim it, but on a longer timer of its own.** Rejected for now rather than
outright, and it is where this goes if growth becomes real. Not taken today
because it needs a retention number nobody can justify yet: how long an operator
might want to reconstruct a Task after the fact is a question no deployment has
been alive long enough to answer.

**Keep the Transcript but let roma read it**, to serve reconstruction directly
rather than pointing an operator at a file. Out of scope and deliberately not
started: ADR-0005 settled that the Transcript is the record and roma writes no
second copy, and a roma that *reads* it acquires a dependency on an undocumented
format that the measurement above shows is Claude Code's to change.
