# Verification: session-id collisions and Transcript reclamation

Date: 2026-07-29
Claude Code **v2.1.220** (`darwin-arm64`, homebrew). Behaviour is version-specific.

ADR-0003 left one hole explicitly unmeasured:

> a conversation that goes quiet for more than 7 days and then comes back is
> spawned with `--session-id` at an id that may still have a transcript. **What
> the CLI does with that is unmeasured.**

This records what it actually does. #35 asks whether roma should reclaim the
Transcript alongside the working directory; three of its four open questions
turned on the answer below.

Method: a throwaway driver (`prototype/transcript-reclamation` branch,
`.scratch/proto/drivers/transcript-reclamation.mjs`) spawning real `claude -p`
processes with an explicitly constructed environment — `CLAUDE_CONFIG_DIR` and
`CLAUDE_SECURESTORAGE_CONFIG_DIR` pointed at a scratch directory so no keychain
login was reachable. Run on the Shared Window token.

**Four Turns total** across two runs, against a hard cap of eight — three of the
first run's five probes resolved at spawn, before a Turn could be started. Q6 was
added afterwards and run on its own (`--only=P5`), on its own session id, so it
inherits no state from the rest.

## Q1 — Where the Transcript lands

```
$CLAUDE_CONFIG_DIR/projects/<slug-of-absolute-cwd>/<session-id>.jsonl
```

The directory name is the Session's **working directory path**, slugified —
`/Users/x/y` becomes `-Users-x-y`. Worth knowing for reclamation: finding a
Session's Transcript needs its cwd, which roma has, but the mapping is Claude
Code's own and undocumented.

One `Reply with OK and nothing else` Turn produced **14,089 bytes over 7 lines**.

## Q2 — `--session-id` at an id that already has a Transcript is refused outright

```
exit code 1
stderr: Error: Session ID aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee is already in use.
events before any send: []
```

Not a silent fresh start, not a silent resume, not a hang. The process dies
before emitting a single stream event, so the failure costs nothing and is
unambiguous.

## Q3 — roma cannot serve a Conversation that outlived its reclaim

**This is the finding that matters.** The probe deleted the working directory and
recreated it empty — exactly what `SessionPool`'s seven-day reclaim leaves behind
— with the Transcript untouched. Result: identical to Q2, `exit 1`, *already in
use*.

`session-pool.ts` decides the flag from the directory alone:

```ts
const resuming = resume ?? existsSync(cwd)
```

So a Conversation that goes quiet past the reclaim and comes back is spawned with
`--session-id`, hits the surviving Transcript, and **fails at spawn. Every
message. Permanently** — nothing in the current design ever removes the
Transcript, so the id stays poisoned for good.

ADR-0003 accepted this as a known hole on the grounds that the behaviour was
unmeasured. It is now measured, and it is not an edge case with an uncertain
outcome — it is a Conversation that is dead and cannot recover on its own.

roma has no handler for it. `NO_CONVERSATION = /no conversation found/i` covers
the *other* failure (Q4) and drives a `resume-lost` log record; nothing matches
*already in use*.

## Q4 — `--resume` with the Transcript deleted fails cleanly and distinguishably

```
exit code 1
stderr: No conversation found with session ID: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
events: [{ type: "result", subtype: "error_during_execution" }]
```

Matches the existing `NO_CONVERSATION` regex, so seam 2's measurement still
holds. Note the different shape from Q2 — one terminal `result` event before
exit, where the collision emitted nothing. The two failures are separable by
stderr, which is what lets roma tell them apart.

Good news for #35: if roma does delete a Transcript, the resulting failure is
recognisable rather than silent.

## Q5 — an id is genuinely reusable once its Transcript is gone

Transcript **and** working directory deleted, same id respawned with
`--session-id`: starts normally, and answering `NONE` to "what word did I ask you
to remember" confirms it carried nothing forward.

This retires the reason ADR-0003 gave for rejecting in-place session reset:

> **Rejected: resetting the session in place** […] It needs no new concept, but it
> turns on unmeasured behaviour.

The behaviour is now measured and it works. Whether `/new` *should* rotate in
place — and whether `session-generation.ts` can therefore go — is #35's to
decide; this only removes the objection that it was unknowable.

## Q6 — `--resume` reaches a Session whose working directory was reclaimed

The repair #40 proposes, measured rather than assumed. Working directory deleted
and recreated empty, Transcript untouched, spawned with `--resume` instead of
`--session-id`:

```
exited: null        (came up and waited)
stderr: []
reply to "what word did I ask you to remember": HALIBUT
```

**The context survives the reclaim entirely.** The Transcript is keyed by a slug
of the absolute cwd, and a directory recreated at the same path resolves to the
same Transcript — so nothing about the reclaim damages the Session, only roma's
reading of whether it exists.

This is the load-bearing measurement for #40: the fix is to reach for `--resume`
where the pool currently reaches for `--session-id`, and a Conversation recovered
that way comes back **with its history**, not as a blank Session wearing the same
id.

Measured on a second session id, in its own run, so it does not inherit state
from Q1–Q5.

## What this does not answer

- **Whether deleting a Transcript is roma's to do.** ADR-0003 says "not ours".
  That is a judgement about ownership, and no measurement settles it — though the
  cost of *not* deleting is now a hard failure rather than a theoretical hole.
- **What happens to a Parked Task.** #35 names this as the case to think hardest
  about; nothing here exercised it.
- **Whether the collision error is stable across CLI versions.** Measured once,
  on one version. The string is not a documented contract.
