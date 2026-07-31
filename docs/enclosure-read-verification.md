# Verification: the Read tool renders an image from disk

Date: 2026-07-31
Status: **run.** ADR-0011's second unverified premise holds. Its *first* premise —
that roma can obtain the bytes from Google Chat at all — was not attempted, and
is still open. See "What this does not settle" below.

Measured on: macOS, Node **22.22.3**, Claude Code **2.1.220** — the version
`Dockerfile` pins and `src/packaging.test.ts` guards, so this is evidence about
the build roma ships rather than about whatever was installed that day. Model
`claude-sonnet-5`, the pinned one.

Two runs, two Turns each, $0.177092 of Shared Window between them. The first is
the one that produced this test, at roma `f349f6a`; the second is #93's gate,
run at `3bb7353` on the same test. Both are below, because they do not agree
about the `marker` Turn and the disagreement is the useful part.

Unlike the other documents in this directory, the evidence here is not a capture
in a branch — it is a test, `src/claude-session.live.test.ts`, and it can be run
again. #73 asked for exactly that: "This belongs in `src/claude-session.live.test.ts`
(seam 2), which exists for exactly this."

## The claim, and why reading the documentation was not enough

ADR-0011 decided that what arrives with a message is written to the Working
Directory as a **file**, rather than handed to Claude Code as an image content
block. The decision's whole load-bearing sentence is:

> Claude Code's Read tool renders an image as readily as it reads text.

It is documented to. That is not the standard this repository uses for claims
about the pinned build — ADR-0003 exists because a documented property of
`--output-format stream-json` turned out to be wrong in a way that cost a
prototype — so the ADR marked it unverified and #73 put it first in the work.

If it were false, the file route would be worse than useless: an Enclosure would
land on disk, the agent would open it, and the Turn would contain no picture. The
fallback would be content blocks, which the ADR rejected on coverage grounds, and
the ADR would need reopening rather than implementing.

## Method

The hard part is not running the Read tool. It is writing an assertion the model
**cannot satisfy any other way** — from the filename, from the file size, from
what a plausible test image usually contains, or from a lucky guess.

So the image is generated per run and its content is drawn at random.
`test/support/striped-png.ts` writes a PNG of five horizontal stripes, each one of
six fully saturated colours, no stripe the same as the one above it: 6×5⁴, one in
3750. There is no dependency and no committed fixture — a PNG is a signature and
three chunks, and a fixture in the repository is a fixture that could be
described from its name.

Two Turns, one Session, a different stripe order in each so the second cannot be
answered out of the first one's context:

| Turn | prompt | what it settles |
| --- | --- | --- |
| **marker** | ADR-0011's marker verbatim — `<from>` and `<enclosure path=… name=… />` — and the question. **No instruction to open anything.** | the mechanism roma will actually use |
| **read-only** | "Use the Read tool on `./b7d1e4.png`, and use no other tool", and the question | the premise itself, with every other route closed |

The second Turn exists because the first one is not conclusive on its own. An
agent handed a path can shell out and decode a PNG with `python`, answer
correctly, and prove nothing whatsoever about the Read tool — so that Turn
asserts the **tool set**, not merely that `Read` appears in it. Tool names come
off the `tool_use` blocks in the stream, sliced per Turn.

The images are also decoded back from disk by the test itself, before anything is
concluded from either Turn. "The agent could not tell you what is in this image"
and "that file is not the image you think it is" are indistinguishable from the
assertion, and only one of them is a fact about Claude Code.

## Result: the premise holds

Run 1, at `f349f6a`:

```
enclosure seam 2 — Claude Code 2.1.220, $0.049291 over 2 Turns
  marker    wrote cyan,red,magenta,yellow,red
            tools Read
            said  "cyan, red, magenta, yellow, red"
  read-only wrote green,magenta,blue,magenta,cyan
            tools Read
            said  "green, magenta, blue, magenta, cyan"
```

Run 2, at `3bb7353`, same build, fresh stripe orders:

```
enclosure seam 2 — Claude Code 2.1.220, $0.127801 over 2 Turns
  marker    wrote green,yellow,red,magenta,green
            tools Bash,Read
            said  "green, yellow, red, magenta, green"
  read-only wrote cyan,red,magenta,cyan,green
            tools Read
            said  "cyan, red, magenta, cyan, green"
```

Four Turns, four exact orders. **The premise rests on the two `read-only` Turns
and on nothing else.** In both runs that Turn's tool set is `{Read}` and nothing
else — no decoder, no shell, no second route to the answer — so the bytes
reached the model as a picture.

### The `marker` Turn is not evidence of the premise

Run 2 is why this has to be said rather than left implied. That Turn called
`Bash` as well as `Read`, and on macOS `Bash` reaches a PNG's pixels
programmatically without difficulty — `sips`, `python3`, a dozen other things. So
a correct colour answer from a Turn that ran `Bash` is **compatible with the
model never having seen the image**.

Run 1's `marker` Turn happened to call `Read` alone. That is a fact about that
run and not about the build, and the test does not assert it — it asserts only
that `Read` appears. An earlier revision of this document read the two runs
backwards and said `Read` was the only tool called in either; it was describing
one sample as though it were a property.

None of this is a flaw in the test. The `marker` Turn settles a different
question — *does the agent go and open the file when nothing tells it to* — and
it settles that one in both runs. It simply cannot also carry the premise, and
the `read-only` Turn exists because it cannot.

Two things worth naming beyond the headline:

- **The agent opened the file unprompted, in both runs.** The `marker` Turn was
  told where the file was and never told to look at it, and `Read` is in its tool
  set either way. This is the property ADR-0011 argued for when it rejected
  handing the agent a shim to fetch with: "an image the agent must know to go and
  fetch is an image the agent will sometimes not fetch". On this build, given the
  tag, it goes. What it does *alongside* Read is not fixed — run 2 also shelled
  out — so this is a claim about reaching the file, not about the route the
  answer took.
- **Both `read-only` answers named a repeated colour correctly** — `magenta`
  twice in run 1, `cyan` twice in run 2, at non-adjacent positions each time. The
  model is reading the picture, not producing a plausible list of distinct
  colours.

## The first run failed, and it was the test that was wrong

Recorded because the failure is easy to reproduce and easy to misread.

The first run drew `red, yellow, magenta, magenta, blue`, and Claude Code
answered `red, yellow, magenta, blue` — four colours for five stripes. That reads
like the premise failing. It is not: **two adjacent stripes of one colour are one
thicker stripe**, and there is nothing in the picture that says otherwise. The
answer was right about the image; the fixture was wrong about the question.

`randomStripes` now refuses to draw a stripe matching the one above it, and says
why. The search space drops from 6⁵ to 6×5⁴ and stays far past guessing.

The general form of this is worth keeping: an assertion about what a model *saw*
has to be an assertion about something the picture actually distinguishes.

## What this does not settle

- **Premise (1) of #73 — whether roma can fetch an attachment from Google Chat
  at all.** Not attempted here. It needs a real Chat space, real credentials and
  a real attachment to inspect, none of which this test has or should have. It
  remains the thing implementation starts with, and the `driveDataRef` half of it
  can still invalidate a slice of the work.
- **Non-image Enclosures.** The Read tool reading text is not in question and is
  not tested here. ADR-0011 leaves the *policy* — size ceiling, what is refused —
  out of scope, and so does this.
- **Anything about a build other than 2.1.220.** Moving the pin is a
  re-verification event; this test is what re-runs.
- **How the image survives the Transcript.** The ADR notes that a Read tool result
  carrying an image is recorded like any other, so what a Turn saw stays in the
  event record after the Working Directory is reclaimed. That is a claim about
  `~/.claude/projects/…` on disk and this run did not look at it.
