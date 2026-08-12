# Verification: whether an appended system prompt survives a `--resume`

Date: 2026-08-12
Status: **run, on 2026-08-12, against Claude Code 2.1.220.** The verdict is
`append-applies` — see *Result*. ADR-0030's fifth verification agenda item points
here, and its Verification status carries the same reading in the
`**Measured — …**` idiom it uses for everything else somebody has looked at.

This document existed ahead of the run on purpose. A measurement that spends the
Shared Window everybody shares is asked once and written down, so the method had
to be settled — and reviewable — before the money moved. Everything above
*Result* is as it was written before the answer was known, which is the point:
the three outcomes and what each would cost were priced with nothing riding on
which one came back.

Instrument: `src/append-on-resume.live.test.ts`, a seam 2 test. Two Turns, both
one word long, so what this costs is cents rather than a context window.

## The claim, and why reading the flag was not enough

ADR-0030 decides that roma tells a Session about its Caveman through
`--append-system-prompt`, which is the channel `ClaudeSession` already owns. The
decision's load-bearing assumption is that the append is in force for as long as
the Session is:

> roma's Sessions are resumed constantly, and a ruleset that applies only to a
> Session's first process is a diet with a hole in it.

`SessionPool.#spawnNow` passes `appendSystemPrompt` to `ClaudeSession` without
looking at `resuming`, and `ClaudeSession.args` puts `--append-system-prompt`
on the argv beside either `--resume` or `--session-id`. So the **flag is present
on a resumed process**, and that much can be read off the source. Whether the
Runtime *applies* it to a conversation that already has a system prompt cannot:
it is a fact about Claude Code, and this repository's standard for those is
ADR-0003's — a documented property of `--output-format stream-json` turned out
to be wrong in a way that cost a prototype, and nothing about the pinned build is
believed here because it is written down somewhere.

If the append does not survive, a Caveman applies to a Session's first process
and silently stops applying at the first Eviction, with `/caveman` still
reporting the level the deployment thinks it is on. Nothing in the free test run
can see that: the flag it asserts on is on the argv either way.

## Method

Three things make this measure what it claims to.

**One Session, resumed under a *different* append.** A run that resumed under the
same text could report only pass or fail. Two texts tell apart the two ways of
failing, which cost roma different things. The append is resolved per spawn —
ADR-0030 proposed that and it is built — but what varies per spawn is the
Session's Caveman, a ruleset rather than arbitrary text, and the announcements a
briefing rides on are still handed over at construction. So the resumed process
comes from a second `SessionPool` over the same Work Root. That
is a route roma really takes: the pool reads whether a Session exists off the
filesystem rather than out of memory, so a second pool over one Work Root is what
a **restart of roma** looks like from the spawn's point of view. The first
process is ended with `evict`, so the resume is the same `--resume` an Eviction
is always followed by, and the test asserts the spawn log reads `resume=false`
then `resume=true` before it reads anything else.

**A codeword nothing else can supply.** Each briefing carries a nonsense token —
`ZARQUON-7413` on the first process, `VELMOTH-2856` on the resumed one. Neither
is answerable from general knowledge, from the filesystem, or from a lucky guess.

**The codeword is never said on the first process.** Its Turn asks whether a
standing briefing is in force, which the briefing answers without naming the
codeword. The Transcript the resumed process inherits therefore contains neither
token, and an answer naming one can only have come from a system prompt. Without
this, "the original append persists" would be indistinguishable from "the model
read its own transcript" — the failure that would have made a passing-looking run
worth nothing.

| Turn | process | prompt | what it settles |
| --- | --- | --- | --- |
| **control** | first, `--session-id`, briefed `ZARQUON-7413` | "Is a standing briefing in force?" | that the append applies at all, without putting a token in the Transcript |
| **reading** | resumed, `--resume`, briefed `VELMOTH-2856` | "What is your codeword?" | which of the three outcomes this build is |

The control is not decoration. Without it, an answer naming no codeword is
ambiguous between *resume drops the append* and *the append never applied to
anything* — a broken instrument reporting a finding.

## The three outcomes, and what each costs

The run classifies its own answer and prints the verdict in `afterAll`, so a
person reading the output is told which outcome happened rather than inferring it
from an assertion message.

| verdict | the answer contains | what it means for roma |
| --- | --- | --- |
| `append-applies` | `VELMOTH-2856` | Agenda item 5 answered yes. ADR-0030 needs no change. |
| `original-persists` | `ZARQUON-7413` | A Session is stuck with whatever it was first spawned under. `/caveman` would report a level the model abandoned at the first Eviction, and the `swap` on a Caveman change would end a process for nothing. |
| `nothing-persists` | neither | Worse, and wider than this ADR: a resumed Session is told nothing about itself at all, **Reach announcements included** (`startup.ts`'s `eachReach`), so ADR-0020's capabilities would go quiet after the first Eviction too. |
| `unreadable` | both | Nobody predicted this. The run is not evidence; read the answer it logged. |

`nothing-persists` is the outcome worth naming loudest, because it is not about
the Caveman. Everything roma has ever put on `--append-system-prompt` is a Reach
announcement, and no measurement in this repository covers a resumed process
receiving one.

## Result

**`append-applies`.** The append is in force on a resumed process.

Run on **2026-08-12**, from a clean checkout at `ab48d09`:

```
npx vitest run --config vitest.seam2.config.ts src/append-on-resume.live.test.ts
```

```
append-on-resume seam 2 (#183) — Claude Code 2.1.220, $0.118313 over 2 Turns
  verdict  append-applies — the append applies on resume — agenda item 5 answered yes
  first    briefed ZARQUON-7413, said "BRIEFING-IN-FORCE"
  resumed  briefed VELMOTH-2856, said "VELMOTH-2856"
  spawns   resume=false resume=true

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Read line by line, because every line is doing something:

- `spawns resume=false resume=true` — the second process reached the Session by
  `--resume`, after an `evict`. Without this the run would be two new Sessions and
  the verdict would be worthless.
- `first … said "BRIEFING-IN-FORCE"` — the control. The append applied to the
  first process, so a missing codeword downstream would have meant *resume drops
  it* rather than *the instrument never worked*.
- `resumed … said "VELMOTH-2856"` — the reading. The resumed process answered
  with the codeword of the briefing **it was resumed under**, not the one the
  Session was created under. That token appears nowhere in the conversation it
  inherited — the first Turn was asked whether a briefing was in force, precisely
  so that it would not say a codeword — so it can only have come from the system
  prompt the resumed process was started with.

**The version is part of the reading.** Every measurement in this repository is
evidence about one build and no other. Both processes reported
`claude_code_version` **2.1.220** — the build `Dockerfile` pins, ADR-0007 argues
for and `src/packaging.test.ts` guards — and the run asserts they agree rather
than letting a reading span two builds. Moving the pin re-opens this question,
and this file is what re-runs.

### What it costs, which is nothing

`append-applies` is the outcome ADR-0030 assumed and the only one that required
no change to it. A Caveman applies for as long as a Session lives, across every
Eviction, Reaping, restart and swap, so `/caveman` reports a level the model is
actually on. ADR-0030's fourth acceptance criterion — a section saying what a
`no` costs and what the design does instead — is therefore not owed, and is
deliberately absent rather than forgotten.

**The reading is wider than the Caveman.** The briefing was handed to the pool as
an *announcement*, which is the same argument a Reach announcement rides
(`startup.ts`'s `eachReach`), and it reached the model on the resumed process
exactly as it would on a new one. So `nothing-persists` — the outcome this
document named loudest, in which a resumed Session is told nothing about itself
at all — is ruled out for announcements too, and not only for the ruleset this
ADR is about.

## What this will not settle

- **Codex.** Everything here is Claude Code's. Whether the app-server takes a
  system-prompt append at all is ADR-0026's agenda item and nothing in this file
  touches it.
- **Whether the append is inside the cached prefix.** Agenda item 3, and a
  different question: this asks whether the text reaches the model on a resumed
  process, not what it costs to send it. A `yes` here says nothing about caching.
- **Compaction.** A Compaction rewrites the conversation without ending the
  process, so it is a third lifecycle beside a new spawn and a resume, and this
  run crosses neither it nor a `/clear`.
- **Whether the *original* append is still in the transcript.** Only the answer
  is read, never the Transcript on disk. `original-persists` would say the model
  behaves as though the first briefing is in force; where that text physically
  lives is a question about `~/.claude/projects/…` that ADR-0006 keeps roma out
  of.
- **Anything about a build other than the one the run names.** Moving the pin is
  a re-verification event, and this test is what re-runs.
