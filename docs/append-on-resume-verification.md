# Verification: whether an appended system prompt survives a `--resume`

Date: 2026-08-12
Status: **not run.** The instrument is committed and the reading is outstanding.
ADR-0030's fifth verification agenda item points here; its Verification status
carries the same fact in the `**Not measured — …**` idiom it uses for everything
else nobody has looked at yet.

This document exists ahead of the run on purpose. A measurement that spends the
Shared Window everybody shares is asked once and written down, so the method has
to be settled — and reviewable — before the money moves. What is missing below is
one table and one sentence, and both are filled in by running one command.

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

**Not taken.** No run of `src/append-on-resume.live.test.ts` has happened.

Filling this in means one command and pasting what it printed:

```
npx vitest run --config vitest.seam2.config.ts src/append-on-resume.live.test.ts
```

It needs `CLAUDE_CODE_OAUTH_TOKEN` in a `.env` at the repo root, and it draws on
the Shared Window everybody shares. The output is one block:

```
append-on-resume seam 2 (#183) — Claude Code <version>, $<spend> over 2 Turns
  verdict  <one of the four> — <what it means>
  first    briefed ZARQUON-7413, said "…"
  resumed  briefed VELMOTH-2856, said "…"
  spawns   resume=false resume=true
```

**The version in that first line is part of the reading.** Every measurement in
this repository is evidence about one build and no other, so the run asserts that
both processes reported the same `claude_code_version` and goes red rather than
let a reading span two. If what it prints is not **2.1.220** — the build
`Dockerfile` pins, ADR-0007 argues for and `src/packaging.test.ts` guards — then
the reading is about a neighbouring build and this document must say so in as
many words, the way ADR-0030's own bundle readings say they were taken on 2.1.227.

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
