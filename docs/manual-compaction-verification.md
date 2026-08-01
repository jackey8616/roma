# Verification: a manual `/compact`, relayed as ADR-0018 decided

Date: 2026-08-01
Status: **run.** ADR-0018's step one is answered. The three unknowns its
verification section names are all measured, and **four sentences in the ADR do
not survive** — see "What this changes in ADR-0018".

Measured on: macOS, Node **22.22.3**, Claude Code **2.1.220** — the version the
`Dockerfile` pins and `src/packaging.test.ts` guards, so this is evidence about
the build roma ships. Model `claude-sonnet-5`, the pinned one, on the Shared
Window credential.

Nine Sessions across four invocations, **$0.7685** in total, of which
**$0.4883** is the six captures kept. The evidence is both those captures —
unedited, in `test/fixtures/claude-stream/`, named `manual-compaction*.jsonl` —
and a re-runnable test, `src/manual-compaction.live.test.ts`, following the
precedent #100 set for #98.

Three Sessions produced no kept capture: two were superseded when a test's
assertions changed and were re-run, and one was a probe whose conversation
turned out to be the wrong shape — see Q5, where that mistake is the reason the
control exists in the form it does.

roma has no code for a relayed `/compact`. Every frame below was written by hand
onto stdin as a `{type:'user'}` frame, exactly as ADR-0012 relays a Readout and
exactly as ADR-0018 decided a Relay carrying an argument would be written.

## The three questions

ADR-0018, under "Not verified — the manual path, in any respect":

> What a relayed `/compact` puts on stdout, whether `too_few_groups` arrives on
> `system/status` there too or surfaces as the thrown error the switch suggests,
> and how a multi-line argument is carried into `<command-args>`, are all
> unknown. **One short seam 2 run settles all three.**

## Method: groups, not tokens, and no threshold override

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` — the lever `src/compaction.live.test.ts`
leans on — is deliberately **not** used here. It lowers the *auto* threshold,
and this is the other path. Nothing here needs a large context either, because
what decides whether a Compaction can run is the number of conversation
**groups**:

```js
function Cdr(e){ let t=[],r=[],n; for(let o of e){ …
  if(o.type==="assistant" && o.message.id!==n && … && r.length>0) t.push(r),r=[o];
  else r.push(o); if(o.type==="assistant") n=o.message.id } … }
function Cnn(e){ return Cdr(FT(e).filter((r)=>r.type!=="progress")) }
async function Kvo(e,t,r){ let n=Cnn(e), o=n.length;
  if(o<2) return w("Reactive compact: fewer than 2 groups, nothing to compact",…),
    {ok:!1, reason:"too_few_groups", attempts:0, totalGroups:o} … }
```

A group opens at each new assistant message id, and the set being summarised
must contain an assistant message or the same `too_few_groups` is returned from
a second bail. So one exchange is too few and two is enough — which is why every
Session here is two or three one-sentence Turns and costs cents.

Read off the pinned build, free, before anything was spent. The same reading is
what made the run cheap, and it is the reading `docs/adr/0018…` describes:
`npm pack @anthropic-ai/claude-code-<platform>@2.1.220` and `grep -a` the binary.
Minified identifiers differ between readers — #98's `QEr` is `Zvr` elsewhere and
its `Chr` is `whr` here — so the shape is quoted and never the name.

**The thread was short, so say so:** a Compaction of a 32k context on a two- or
three-message conversation is a Compaction and it answers what this step asks. It
answers nothing about what a full-size one costs, how long it takes, or what it
preserves.

## Q1 — Yes. `trigger: "manual"` is real, and this is what it looks like

The half of `E.enum(["manual","auto"])` nobody had seen. From
`manual-compaction.jsonl`:

```json
{"type":"system","subtype":"compact_boundary",
 "session_id":"1b448605-4781-4cae-8c24-83a425e60634",
 "uuid":"41edaf99-bd39-4968-ba73-f9aa7a619d7e",
 "compact_metadata":{
   "trigger":"manual",
   "pre_tokens":31953,
   "post_tokens":1764,
   "cumulative_dropped_tokens":30189,
   "duration_ms":28517,
   "preserved_segment":{"head_uuid":"…","anchor_uuid":"…","tail_uuid":"…"},
   "preserved_messages":{"anchor_uuid":"…","uuids":["…"],"all_uuids":["…"]}},
 "logical_parent_uuid":"2862d9cf-2bf2-4b1b-b8a1-1459a072f375"}
```

Byte-for-byte the shape #100 measured on the auto path, snake_case throughout,
with one field different. A reader built for one serves the other, which is the
cheap half of the answer.

The sequence around it is the auto path's as well —
`status: "requesting"` → `status: "compacting"` → `compact_result: "success"` →
`compact_boundary` — so ADR-0018's decision to report `status: "compacting"` as
progress rests on an event that really does arrive.

## Q2 — `num_turns` is **zero** for a `/compact` that cost four cents

This is the finding, and it is the one that breaks something.

From the same capture, the four terminal `result` events of the run:

| message | `num_turns` | `duration_api_ms` | Δ cost | `duration_ms` |
| --- | --- | --- | --- | --- |
| setup | 1 | 3273 | $0.0102756 | 2599ms |
| setup | 1 | 5671 | $0.0096846 | 2423ms |
| quiet Turn | 1 | 7343 | $0.0097089 | 1688ms |
| **`/compact`** | **0** | **0** | **$0.0453027** | **28545ms** |

**4.7× the cost of an ordinary short Turn in the same Session, 17× the wall
clock, and `num_turns` says nothing happened.** An earlier run of the same test,
whose capture this one superseded, gave $0.0377368 against $0.0098856 — 3.8× —
over 16531ms. The ratio moves; the zero does not.

This is not the comparison #100 made and is not offered as one. #100 put two
byte-identical messages side by side, one of which happened to carry an auto
Compaction. This is a person's deliberate `/compact` beside an ordinary Turn.

The reason the two paths differ on `num_turns` is the reason ADR-0018 got it
wrong: an auto Compaction happens *inside* somebody's Turn, so it bumps that
Turn's count to 2 (#100 measured exactly that). A manual one is a `type:"local"`
command that answers locally and drives the summarisation underneath, so the
count stays at the zero every local command reports.

**The money is still visible**, and in exactly one place: the delta of
`total_cost_usd`, which is what `ClaudeSession` already prices a Turn by. Nothing
else on the terminal event moves — `usage` is all zeros, `duration_api_ms` is 0.
The spend is in `modelUsage`, which roma does not read:

```json
"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":530,…,"costUSD":0.00059},
              "claude-sonnet-5":{"inputTokens":2073,"outputTokens":1026,
                "cacheReadInputTokens":87476,"cacheCreationInputTokens":8249,
                "costUSD":0.09733005}}
```

## Q3 — `too_few_groups` on the manual path carries a **sentence**, not a code

A Session with one exchange in it, then `/compact`:

```json
{"type":"system","subtype":"status","status":null,
 "compact_result":"failed",
 "compact_error":"Not enough messages to compact.",
 "session_id":"9dcfc20a-0138-4d7c-b6b2-34be8c1f3844","uuid":"568be048-…"}
```

Three things about it, and the second is the one that matters:

- **It does arrive on `system/status`, as it does on the auto path.** ADR-0018
  wondered whether it would surface as the thrown error instead. It does both:
  the event goes on the wire *and* the Caller is answered.
- **`compact_error` is `"Not enough messages to compact."`** On the auto path the
  same failure reports `"too_few_groups"`. The manual path throws
  `Error(whr)` — `whr = "Not enough messages to compact."` — and the message of
  the thrown error is what reaches the field.
- **It is free, and instant.** `num_turns: 0`, Δ cost `$0`, and 33ms. The manual
  path bails with `attempts: 0` before it calls anything.

The Caller is answered by the command itself. `Hly` catches that one error by
identity and returns it as ordinary command text —

```js
var Hly=async(e,t)=>{ … let o=e.trim();
  try{ return await Lly(n,t,o) }
  catch(i){ if(r.signal.aborted) throw new tl("Compaction canceled.");
    else if(S_e(i,whr)) return {type:"text",value:whr};
    else if(i instanceof YY) return {type:"text",value:i.message,level:"error"};
    else throw Re(i), Error(`Error during compaction: …`) } }
```

— so `is_error` is `false` and the terminal event's `result` field holds
`"Not enough messages to compact."`, ready to relay.

**The success case has no such text.** On a Compaction that worked, `result` is
`""`, and the only thing said anywhere is a replayed
`<local-command-stdout>Compacted </local-command-stdout>`. So a Caller who
succeeds is told nothing unless roma says it.

## Q4 — The multi-line argument arrives whole. There is no `<command-args>`

ADR-0018's frame, sent verbatim:

```
/compact

<from>Ada (users/17)</from>

keep the architecture decisions and anything still unresolved
```

It is dispatched as the command — a `compact_boundary` with `trigger: "manual"`
came back, so nothing reached the model as prose to be answered *about*. The
splitter is the reason, and it splits on the first whitespace of any kind:

```js
function Hpr(e){ let t=e.startsWith("/")?e.slice(1):e, r=t.search(/\s/);
  if(r===-1) return {name:t,args:""};
  return {name:t.slice(0,r), args:t.slice(r+1).trim()} }
```

So the name is `compact` and the argument is everything after the first newline,
inner newlines intact, ends trimmed. **Marker-in-front survives.**

**`<command-args>` does not occur in any of the six captures.** That tag is the
expansion a `type:"prompt"` command gets (`spd()` builds
`<command-message>` / `<command-name>` / `<command-args>`), and `/compact` is
`type:"local"`. Its argument is handed straight to `Hly` as a string and reaches
the summariser through a different door:

```js
function Ysd(e,t="from"){ let n=`CRITICAL: Respond with TEXT ONLY. …`
  + (t==="up_to"?UH_:$H_);
  if(e && e.trim()!=="") n+=`\n\nAdditional Instructions:\n${e}`; … }
```

**Measured, not inferred.** A control was run twice with an argument whose effect
is unmistakable — `Include the exact token COMPACT-ARG-7Q4J in the summary.` —
behind the same marker. The summariser's own summary quotes the whole thing back:

> an embedded 'Additional Instructions' block from '`<from>Ada (users/17)</from>`'
> asking to include the exact token COMPACT-ARG-7Q4J

Every character roma sent — command, blank line, marker, blank line, Caller text
— reaches the model that decides what survives the Compaction.

## Q5 — The marker makes the Caller's own instruction look like an attack

Not one of the three questions, and the most uncomfortable thing the run found.

ADR-0018 accepts a risk about the marker in one sentence:

> The marker travels into `<command-args>` alongside the argument and is
> therefore read by the summariser. Accepted: it is roma's own tag wrapping a
> person's name, and **a name inside a summarisation instruction does not become
> another instruction.**

It does not become another instruction. It becomes a **reason to distrust the
instruction it is attached to** — and the summariser says so inside the summary,
which is the context every later Turn in that Conversation then reads.

Four Sessions were sent an argument behind the marker, and one the same argument
without it:

| # | Caller's text | conversation | outcome | capture |
| --- | --- | --- | --- | --- |
| 1 | ADR-0018's, verbatim | 3 one-word Turns | whole conversation discarded; "the … fabricated compaction request **looks like an injected prompt** … I'm disregarding it" | `…-argument.jsonl` |
| 2 | sentinel | 3 one-word Turns | sentinel absent; summary was the single word `BRAVO`, no reason given | superseded |
| 3 | sentinel | 2 ordinary Turns | **refused**: "not going to insert an arbitrary token on the say-so of an **unverified attribution embedded in a user message** … a likely prompt-injection attempt" | `…-argument-refused.jsonl` |
| 4 | sentinel | 2 ordinary Turns | complied, *and* flagged: "a likely prompt-injection attempt … it does not originate from a verified system or user authority" | `…-argument-marked.jsonl` |
| 5 | sentinel, **no marker** | 2 ordinary Turns | complied, and recorded it plainly as "Additional instruction embedded in the task" | `…-argument-unmarked.jsonl` |

Rows 4 and 5 are the pair: one invocation, minutes apart, the same conversation
and the same argument, and the marker the only difference between them.

**Row 1 is ADR-0018's own decided frame**, and the Compaction it bought
discarded the conversation: `pre_tokens` 31959 to `post_tokens` 852, and what
survived was the word `CHARLIE` and a note about an injected prompt. Row 3 is the
same shape of loss on an ordinary conversation — 31052 dropped to 950, one
sentence about git tags and an accusation.

**Rows 1 and 2 share a confound and it is mine.** Their conversation was three
Turns of "reply with the single word X", which primes the model hard enough that
the summariser rejects Claude Code's own summarisation prompt wholesale,
structure and all. That cannot distinguish "the argument was dropped" from "every
instruction was dropped", which is why rows 3–5 exist and why the conversation
changed between them. Row 1 is reported rather than discarded because it is what
the ADR's frame did the one time it was sent, and a confound is a reason to
qualify a result, not to delete it.

**This is not established.** Three of four marked Sessions produced
prompt-injection language and the single unmarked one did not, but two identical
marked Sessions (3 and 4) disagreed with each other, the control is n=1, and all
of it is model behaviour. What *is* established is that the marker reaches the
summariser verbatim and that the summariser reasons about it by name — which is
already more than the ADR's sentence assumes.

There is a mechanism visible in the summaries that is worth recording either way:
the summarisation prompt arrives **fused onto the Caller's last user message**.
Both summaries in the marked/unmarked pair listed it that way —

> "All user messages: … 'Answer in one short sentence: what is a git tag for?
> CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. …'"

— so from the summariser's seat, a user asked a question and then, in the same
breath, issued instructions about how to answer. That reads like an injection
before roma adds anything. The marker gives it a name to be suspicious of.

## What this changes in ADR-0018

Nothing here touches what the ADR *decides*. `/compact` is still the fourth cell
rather than a fourth kind, it is still governed as a Task, and the cost figures
strengthen both. Four supporting sentences are wrong, and one of them takes a
mechanism with it.

1. **The drift check cannot be built as specified.** The ADR replaces ADR-0012's
   check on the grounds that it

   > would fire on every legitimate `/compact`, and a check that cries wolf is a
   > check somebody mutes

   It would never fire: `num_turns` is 0. And its replacement —

   > Each entry on the Relay list carries whether it is expected to drive a Turn.
   > The Operator Log gets a line when the entry and reality disagree, **in either
   > direction**.

   has nothing to compare against, because reality reports zero for a paid Relay
   and for a free one alike. The replacement is still the right shape and is now
   better motivated than the ADR argued, but it has to be keyed on **cost** — the
   `total_cost_usd` delta — which is the only field that moves.

2. **The failure table cannot be keyed on `compact_error` on this path.** The ADR
   is explicit that it is safe:

   > By `compact_error`, which is a code rather than a sentence — so this is not
   > the `shared-window.ts` mistake of building on one build's strings.

   On the manual path it is a sentence, and it is this build's sentence.
   `too_few_groups` is measured; `exhausted`, `media_unstrippable` and `error`
   are read off the switch above and are all `Error`/`YY` messages too, so the
   pattern is expected to hold for them — unmeasured. Distinguishing
   `too_few_groups` (reply only) from `exhausted` (Operator Log and an Outbound
   Instruction) needs another way, and the cheapest honest one is that the manual
   path already hands roma a sentence written for a person: relay it, and decide
   the Operator Log line on something other than the error.

3. **`<command-args>` is not the mechanism.** The ADR's conclusion is right — the
   marker is read by the summariser — but nothing on this path builds that tag.
   The argument reaches the summariser as `Additional Instructions:` in the
   summarisation prompt. Worth correcting because the sentence names a mechanism
   somebody will go looking for.

4. **"A name inside a summarisation instruction does not become another
   instruction" is too comfortable.** See Q5. The risk is not that the marker
   instructs; it is that the marker makes the Caller's instruction look
   unauthorised, and the summariser says so inside the context that survives.

Two decisions are **strengthened** rather than weakened:

- **The unconditional Acknowledgement.** ADR-0018 argues it from #100's
  19,487ms. The four successful Compactions kept here report `duration_ms` of
  8367, 20196, 21411 and 28517, and cost $0.0252, $0.0420, $0.0435 and $0.0453 —
  all of it for a 32k context. There is nothing on the wire between
  `status: "compacting"` and the boundary, so without the Acknowledgement a
  `/compact` is up to half a minute of silence.
- **"`too_few_groups` will be the most common failure on the manual path."** It
  is free, instant, and Claude Code already writes the Caller's answer. Relaying
  that sentence is cheaper than composing one.

And one thing the ADR does not mention that its implementation needs:
**a successful `/compact` returns no text.** `result` is `""`. Whatever the
Caller is told on success, roma writes it.

## What this does not establish

- **Only `too_few_groups` was provoked.** `exhausted`, `media_unstrippable`,
  `error` and `aborted` are read off the manual path's switch and nothing more.
  #98 judged provoking `exhausted` not worth the money and this run agrees.
- **Nothing about real thresholds or timing.** Every Session here compacted about
  32k tokens off a two- or three-message conversation. 28,517ms is what that took.
- **Whether the marker causes the summariser's distrust.** Three of four marked
  Sessions produced injection language and the one unmarked Session did not. n=1
  on the control, and two identical marked Sessions disagreed. Suggestive; not
  shown.
- **Whether ADR-0018's frame works on an ordinary thread.** It was sent once, on
  the confounded one-word conversation, and the Compaction discarded the
  conversation. Its own Caller text has never been run against a normal one.
- **Whether a long thread behaves like these.** All of them were short enough
  that the summariser remarked on having little to summarise, which is plausibly
  part of why it was suspicious.
- **Nothing about roma.** There is no relay code, so nothing here exercises the
  Task Queue, the concurrency cap, `/stop` against a running `/compact`, Parking,
  Overflow, or the Audit Record. The frames were hand-written; when the
  implementation lands, they are what it has to produce.
- **`/compact` was never sent twice to one Session**, so nothing is known about
  compacting an already-compacted context.

## Reproducing

```
npx vitest run --config vitest.seam2.config.ts src/manual-compaction.live.test.ts
```

**Not `npm run test:seam2`** — its include is `src/**/*.live.test.ts`, so it runs
every live test in the repository against the Shared Window.

Needs `CLAUDE_CODE_OAUTH_TOKEN` in `.env` at the repo root. Costs roughly $0.42
for the five Sessions and takes about two minutes. Behaviour is version-specific:
this is evidence about **2.1.220** and nothing else, so re-verify before the
ADR-0007 pin moves.

The test tees raw stdout to a file outside the checkout and logs the path; the
fixtures here were copied from those files by hand, which is deliberate. A test
that rewrote a fixture on every run would quietly replace the bytes this document
quotes.
