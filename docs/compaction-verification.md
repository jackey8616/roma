# Verification: a Compaction announces itself on roma's stdout

Date: 2026-07-31
Status: **run.** #98's step one is answered, and two of the things step two was
going to be built on turn out to be wrong. See "What this changes in #98" below.

Measured on: macOS, Node **22.22.3**, Claude Code **2.1.220** — the version the
`Dockerfile` pins and `src/packaging.test.ts` guards, so this is evidence about
the build roma ships. Model `claude-sonnet-5`, the pinned one, on the Shared
Window credential.

Two probe runs, seven Turns, **$0.4248** between them, and then the whole thing
again through the test that came out of them — **$0.85 in total**. The evidence
is both a pair of captures — `test/fixtures/claude-stream/compaction-auto.jsonl`
and `compaction-failed.jsonl`, unedited — and a re-runnable test,
`src/compaction.live.test.ts`, following the precedent #73 set for ADR-0011.

Everything below is from the probe run, which is what the captures hold. The test
run is an independent second observation of the same facts and it agreed: a
`compact_boundary` with `trigger: "auto"`, `pre_tokens` 62517 against 61486,
`post_tokens` 1917 against 1375, and the identical-message pair at $0.0190 over
one Turn against $0.0886 over two. The figures move a little run to run; nothing
that is asserted does.

## The question

#98 put it in one line:

> **Does `system/compact_boundary` reach roma's stdout?**

The event's *shape* was certain, read out of Claude Code's own parser. Its
*delivery* was not: that parser reads transcript files, and nothing said the
same events go down `--output-format stream-json`'s stdout. ADR-0005's position
made it likely and the issue refused to build on likely, for the reason ADR-0003
exists — a documented property of `--output-format stream-json` was already
wrong once, expensively.

## Method: a fourth rung the issue did not have

#98 laid out three ways to provoke a Compaction without filling a real context
window. There is a fourth, and it is better than all of them. The pinned bundle:

```js
testPctOverride;
if (n !== undefined && !isNaN(n) && n > 0 && n <= 100)
  return Math.min(Math.floor(e * (n / 100)), r);
return r
```

fed from

```js
let n = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
    o = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE;
return { enabled: JI(), precomputeBufferFraction: …,
         testPctOverride: n ? parseFloat(n) : undefined, … }
```

`e` is the context window, so the auto-compact threshold becomes a percentage of
it, read from the environment on every call. Three properties earn it the job:

- **No feature gate.** The issue's rung 1 — `/autocompact` written to stdin — is
  fenced behind `isEnabled(){ return p2d() && (_n() || ba()) }`, and `p2d()` is
  `!!bfo()` where `bfo()` is `Ke("tengu_amber_redwood2","") || Ke("tengu_amber_redwood3","")`:
  a remote experiment flag, which may simply be off for an account. Untried, so
  whether it is on here is still unknown.
- **No model guard.** Its neighbour `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is read
  `if (n !== undefined && n > 0 && !lo(Ei(e)).startsWith("claude-")) return n` —
  ignored for every model roma runs. This one has no such clause.
- **It can only lower the threshold.** `Math.min` against the normal value, so a
  typo cannot produce a Session that quietly never compacts.

Rung 2 (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) does exist and does take precedence
over the settings file — its own error text says so — but its parser refuses
anything under 100k tokens (`Expected 'auto' or 100k–1M tokens`), matching the
session-option schema's `.min(1e5)`. So it works and it is still expensive. Rung
3 was not needed.

**The threshold was shrunk, so say so:** a Compaction at a 40k threshold is a
Compaction and answers the question this step asks. It answers nothing about
where the real threshold sits, how long a full-size one takes, or what a real one
preserves.

### The baseline, which is what makes the percentages meaningful

`/context` on a freshly spawned roma-shaped Session, free because it is a Readout
(`num_turns: 0`, `total_cost_usd: 0`):

| Category | Tokens |
| --- | --- |
| System prompt | 8.9k |
| System tools | 17.4k |
| System tools (deferred) | 15.3k |
| Memory files | 649 |
| Skills | 2.9k |
| Messages | 8 |
| **Total** | **29.9k / 967k** |
| *Autocompact buffer* | *33k* |

26.6k of that is system prompt and tool schemas — not conversation, and nothing a
Compaction can summarise away. So `pct=4` (≈40k) is a threshold a conversation
can grow into, and `pct=1` (≈10k) is one it can never be reduced under. Those are
the two runs.

**Which world this was measured in — it is no longer the one seam 2 runs in.**
This Session picked up the repo's own `CLAUDE.md` (649 tokens) and project skills
(2.9k), because `liveSessionDirs` put the working directory at `.tmp/seam2/work/`
— inside the repository, where Claude Code's walk up from the working directory
finds them. That was #101 and it is fixed: the seam 2 directories now live under
`os.tmpdir()`, outside the checkout, and `test/support/live-claude.test.ts`
asserts it for free.

So **the 29.9k above is the contaminated figure**, and the same measurement today
should come out around 3.5k lower — the Memory files and Skills rows going to
roughly zero and nothing else moving. The numbers in this document are left as
they were measured rather than adjusted to a figure nobody has seen; the fixtures
`compaction-auto.jsonl` and `compaction-failed.jsonl` were captured in that same
contaminated world too.

Nothing asserted depends on it. `src/compaction.live.test.ts` re-reads `/context`
at the start of every run instead of trusting the constant, and its
`BASELINE_TOKENS` is a floor for `pre_tokens` — a floor that a *lower* real
baseline only makes safer, since the filler Turn is what carries `pre_tokens` past
it either way.

## Q1 — Yes. It is on stdout

```json
{"type":"system","subtype":"compact_boundary",
 "session_id":"17d76509-0ab1-4247-bdc5-c953864a4ac4",
 "uuid":"ef641207-e918-4560-b363-ef10e6a8586f",
 "compact_metadata":{
   "trigger":"auto",
   "pre_tokens":61486,
   "post_tokens":1375,
   "cumulative_dropped_tokens":60111,
   "duration_ms":19487,
   "preserved_segment":{"head_uuid":"…","anchor_uuid":"…","tail_uuid":"…"},
   "preserved_messages":{"anchor_uuid":"…","uuids":["…","…"],"all_uuids":["…","…"]}},
 "logical_parent_uuid":"9f2bffa4-2d03-46c3-b12c-26d153c571f6"}
```

Read by `ClaudeSession`'s own `event` listener, off the same stdout every other
event roma reads arrives on. Step two is unblocked.

## Q2 — But not in the shape #98 quoted

The issue expects:

```json
{"type":"system","subtype":"compact_boundary",
 "compactMetadata":{"preservedSegment":…,"preservedMessages":…}}
```

That is the **Transcript's** spelling, which is what the parser the issue quotes
was reading. On stdout it is `compact_metadata`, snake_case throughout, and the
bundle has a mapper that does exactly that conversion on the way out:

```js
function QEr(e){ let {preservedSegment:t, preservedMessages:r} = e; return {
  trigger: e.trigger, pre_tokens: e.preTokens,
  ...e.postTokens !== undefined && {post_tokens: e.postTokens},
  ...e.cumulativeDroppedTokens !== undefined && {cumulative_dropped_tokens: …},
  ...e.durationMs !== undefined && {duration_ms: e.durationMs},
  …
  ...t && {preserved_segment:{head_uuid:t.headUuid, anchor_uuid:t.anchorUuid, tail_uuid:t.tailUuid}},
  ...r && {preserved_messages: …} } }
```

confirmed by the wire schema, which is where `trigger`'s two values come from:

```js
subtype: E.literal("compact_boundary"),
compact_metadata: E.object({
  trigger: E.enum(["manual","auto"]),
  pre_tokens: E.number().int(),
  post_tokens: E.number().int().optional(),
  cumulative_dropped_tokens: E.number().int().optional(), … })
```

A reader written from the issue's quote finds `undefined` and reports every
Compaction as no Compaction. This is the whole reason the measurement came first.

## Q3 — The cost really does land on the wrong person

This is #98's central claim, and it had never been shown. The run sends **two
byte-identical messages** — `Reply with the single word OK. Do not use any
tools.` — one before the threshold is crossed and one after:

| Turn | `num_turns` | cost | wall clock |
| --- | --- | --- | --- |
| `/context` | 0 | $0 | 1189ms |
| filler (~14k tokens) | 1 | $0.2337252 | 1960ms |
| **`OK`, quiet** | **1** | **$0.0186429** | **1814ms** |
| **`OK`, carrying the Compaction** | **2** | **$0.0917049** | **21836ms** |
| `/context` | 0 | $0 | 1042ms |

**4.9× the cost and 12× the wall clock for the same message**, and 19,487ms of
those 21,836ms are the Compaction's own `duration_ms`. Nothing distinguishes the
two in an Audit Record today. A Conversation is many people sharing one Session,
so the person who paid is whoever happened to type next.

The 19.5 seconds are worth their own note: that is dead stream inside somebody's
Turn, the same shape of problem as the 25339ms tool window that
`readToolStarted` exists for. `system/status` with `status: "compacting"` marks
the start of it, so it is reportable.

## Q4 — A failed Compaction has its own event, with a machine-readable code

Provoked by putting the threshold under the floor (`pct=1`):

```json
{"type":"system","subtype":"status","status":null,
 "compact_result":"failed","compact_error":"too_few_groups",
 "session_id":"06e25a39-3cb7-4333-831b-ee1d838d0cae","uuid":"a4d4ac52-…"}
```

Three things about it:

- **It is not a `compact_boundary`.** It arrives as `system/status` — an event
  that also carries ordinary progress (`status: "requesting"`, `status:
  "compacting"`). The only thing marking one is the presence of
  `compact_result`, which the wire schema declares as
  `E.enum(["success","failed"]).optional()` beside `compact_error: E.string().optional()`.
- **`compact_error` is a code, not a sentence.** `too_few_groups`. #98 explicitly
  rejected matching on the failure's error *text* — "the mistake
  `shared-window.ts` already made once" — and this is the field that makes that
  rejection free rather than a compromise.
- **A successful Compaction emits one too**, `compact_result: "success"`, just
  before the `compact_boundary`. So the full sequence is
  `status: "compacting"` → `compact_result` → (if successful) `compact_boundary`.

## Q5 — A failed Compaction does **not** mean a dead Session

This is the finding that changes the design, and it came from the *successful*
run rather than the failing one. `compaction-auto.jsonl` contains **both**:

| # | event | during |
| --- | --- | --- |
| 1 | `status: "compacting"` → `compact_result: "failed"` (`too_few_groups`) | the quiet `OK` Turn, $0.0186, 1 turn, **no error** |
| 2 | `status: "compacting"` → `compact_result: "success"` → `compact_boundary` | the next `OK` Turn |

So a failed Compaction happened in the middle of a perfectly ordinary, cheap,
successful Turn, and was retried and succeeded on the next one. In the dedicated
failure run the same thing: `compact_result: "failed"`, and then the Session
served the following Turn normally at $0.0104.

`too_few_groups` reads as "there is not enough conversation here to summarise
yet" — a *benign* failure, and on this evidence the common one.

## What this changes in #98

Step two is unblocked, and two of its decisions need revisiting before they are
built.

1. **The reader must key on `compact_metadata`, not `compactMetadata`.** As
   written, the issue's shape would make roma blind to every Compaction while
   looking like it worked.

2. **"A failed Compaction is an operational event, and the Caller is told" is too
   strong.** The issue's reasoning — "a failed Compaction is a Session that
   cannot serve another Turn, and that is squarely what an operator needs to
   know" — does not hold for the failure that actually arrives. Built as
   specified, roma would put a line in the Operator Log and send an Outbound
   Instruction telling a Caller "this thread is full, use `/clear`" *during a
   healthy Turn that cost two cents and worked*. That is a false alarm on the one
   channel ADR-0010 sets a high bar for using.

   What the evidence supports instead is distinguishing failures by
   `compact_error`. `too_few_groups` is not an operational event. The serious one
   the issue is really about — the Session that cannot be reduced below the
   context limit — presumably carries a different code, and **that** is the one
   worth an Operator Log line and an Outbound Instruction.

3. **Everything else in step two survives.** A successful Compaction as an
   optional Audit Record field, absent meaning none, is if anything better
   supported than the issue argued: `cumulative_dropped_tokens` and `pre_tokens`
   / `post_tokens` mean the record can say how much context the money bought.

## What this does not settle

- **The serious failure was not provoked.** The build carries `Compaction failed
  · conversation could not be reduced below the context limit` and `Compaction
  failed · attached media exceeds size limits`, thrown from a switch on
  `media_unstrippable` / `error` / a third case. What was measured is
  `too_few_groups`, a different branch. So the *event* carrying a failure is
  measured; the *code* for the failure #98 cares about is not, and point 2 above
  rests on the codes differing, which is read rather than measured.
- **Nothing about real thresholds or timing.** The window was shrunk to 4% of
  itself. 19,487ms is what compacting 61k tokens took, not what compacting a full
  967k context takes.
- **`manual` was not exercised.** `trigger` is `E.enum(["manual","auto"])` and
  only `auto` was seen. #89 is where `manual` would come from.
- **Rung 1 is still untried**, so `p2d()`'s experiment flag is unmeasured. It was
  not needed and it would have cost a Turn to find out.

## Two things found on the way that belong elsewhere

- **ADR-0014's `yn()` is readable after all.** It records the predicate deciding
  which of Claude Code's two `/model` descriptors is live as "not readable
  statically". In this build it is `function _n(){ return !Mt.isInteractive }` —
  the plain `local` descriptor is the one that answers under `-p`, always, by
  construction, which agrees with what ADR-0014's live probe observed. Worth
  amending the ADR: it is a fact roma can rely on rather than one run's result.
- **roma has an off switch it did not know about.**
  `function JI(){ if (Z.DISABLE_COMPACT) return false; if (Yt(process.env.DISABLE_AUTO_COMPACT)) return false; return Hc("autoCompactEnabled", true).value }`.
  Auto-compaction can be turned off per-process from the environment, which
  `buildEnv` owns. Not a recommendation — discarding a Conversation's context is
  bad, and failing every Turn once the context fills is worse — but the decision
  is roma's to make rather than one it is subject to, and the ADR should say so
  rather than leave it looking impossible.

## Reproducing

```
npm run test:seam2 -- src/compaction.live.test.ts
```

Needs `CLAUDE_CODE_OAUTH_TOKEN` in `.env` at the repo root. Costs roughly $0.42
and takes about a minute. Behaviour is version-specific: this is evidence about
**2.1.220** and nothing else, so re-verify before the ADR-0007 pin moves.
