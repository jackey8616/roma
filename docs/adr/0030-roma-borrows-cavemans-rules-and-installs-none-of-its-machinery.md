# 30. roma borrows caveman's rules and installs none of its machinery

Date: 2026-08-12

## Status

Accepted, and **implemented** (#183–#190, under the map #182). `src/caveman.ts`
holds the borrowed ruleset, the level filter and the Menu;
`test/fixtures/caveman/SKILL.md` is the upstream file it was derived from and
`src/caveman.test.ts` holds that file's hash and the four rewrites.
`ROMA_CAVEMAN` is refused at boot in `src/env-config.ts`, `chosenCavemen` in
`src/session-generation.ts` is the third Chosen Record adapter, `SpawnTerms` in
`src/session-pool.ts` carries the level onto every spawn and the swap has its
fourth reason, `Core.#answerCaveman` answers `/caveman` and `#settingsReport`
says it where this Session's is not `off`, and `src/channels/google-chat/` draws
the Menu as buttons and reads a press back.

**Amended 2026-08-12 by ADR-0029's Channel** (#176). `src/channels/discord/`
draws it and reads a press back too, on the same terms and with no change to
`ChannelAdapter`. The decisions here are untouched; what the amendment corrects
is a sentence that named the only Channel there was when it was written.

**Implemented is not verified, and holding those apart is most of what this file
was written to do.** Nothing here has been measured against roma's own traffic,
and the claim the whole thing exists for — that it saves anything — is still
deliberately **not made**. What landed beside the mechanism is the instruments
for making it: the Audit Record now carries the level and the Turn's output
tokens, which is what lets a deployment answer agenda item 1 from its own months
rather than from a synthetic prompt, and `src/append-on-resume.live.test.ts` is
item 5's. That one has since been spent, and it is the only claim in this file
that has moved from assumed to measured: **the append survives a `--resume` on
2.1.220**, so a Caveman applies for as long as a Session lives. The agenda at the
end is shorter by one item and longer by another, both from the same re-reading —
see *Verification status*.

Follows ADR-0016 in shape and ADR-0014 in shape: a thing every Session runs
with, pinned by the operator and moved by a person, kept in a Chosen Record and
carried on every spawn. It is the third such thing, which is why `ChosenRecord`
stops saying "twice" below.

This file was 0027, then 0028, and is 0030 because `main` took each of those
numbers while it was being written — `/usage` first, then the second Channel and
Discord. `check:adr-collision` caught the first locally and the second in CI,
which is the check's own account of itself working as written: it reads main as
main is right now, and nothing re-runs it when main moves. Renumbering is the
whole of what that cost, twice.

Only the first collision was adjacent in anything but number. ADR-0027 put the
Runtime on the Audit Record on the argument this file uses for the Caveman level,
and made `/caveman` the seventh Command rather than the sixth; ADR-0028 and
ADR-0029 are about Channels and touch nothing here.

### Verification status

Read rather than run, with one exception, and the exception is the load-bearing
one. The readings about Claude Code taken off the binary — the two immediately
below, on where a skill is found and what an uninvoked one costs — are off the
pinned build, **2.1.220**, the version `Dockerfile` and `src/packaging.test.ts`
both carry. The **Measured** ones after them are off `jackey8616/caveman` at its
pinned commit — readings about a third-party repository, which no Claude Code
version dates. The last **Measured** block is neither: it is a run, two real
Turns against the Shared Window, and it names 2.1.220 for itself rather than
inheriting it from this paragraph.

The two were first taken on 2.1.227 and have been re-taken here, because a
reading inherited from the build next door is not evidence about the build roma
ships, and ADR-0007's pin is what makes that a requirement rather than a
courtesy. The pin was checked rather than assumed: #160 reports npm's `latest`
at 2.1.226 and is open, unacted on, and asks for nothing — declining that check
is a normal outcome, and 2.1.220 is what the image installs until somebody
decides otherwise.

**The method changed, because the artefact did.** 2.1.220's npm package is a
500-byte `bin/claude.exe` and a postinstall that copies a native binary over it,
so there is no bundle to open: the quotes below are the JavaScript embedded in
`@anthropic-ai/claude-code-linux-x64@2.1.220`, recovered with `strings` and
`grep -a`. Minified names therefore differ from the 2.1.227 quotes this section
used to carry — `O8` is `fn` here — and that is not a finding, because a build
renames them for free. Behaviour moving is the finding, and where it moved it is
said so below.

**Measured — where Claude Code looks for a skill.**

```js
function Akl(){return process.env.CLAUDE_CONFIG_DIR}
fn=Vr(()=>(Akl()??dye.join(Tkl.homedir(),".claude")).normalize("NFC"),Akl)
…
let t=E_.join(fn(),"skills"),r=E_.join(cB(),".claude","skills"),n=J$t("skills",e);
w(`Loading skills from: managed=${r}, user=${t}, project=[${n.join(", ")}]`)
```

A user skill lives under `CLAUDE_CONFIG_DIR`, which for roma is
`ROMA_CLAUDE_CONFIG_DIR` — the volume the README requires be durable and
ADR-0006 forbids roma to delete from. That reading holds unchanged; 2.1.220
splits the environment read from its fallback where 2.1.227 inlined the two, and
lands on the same directory.

The project reading holds as well, and **this file stated it narrower than the
resolver it was describing** — which is what re-reading it turned up. `project`
is a list rather than a path, and `n.join(", ")` was saying so on 2.1.227 too:

```js
function J$t(e,t){let r=nX.resolve(xap.homedir()).normalize("NFC"),n=P2_(t),o=nX.resolve(t),i=[];while(!0){if(pv(o)===pv(r))break;let s=nX.join(o,".claude",e);try{Cap.statSync(s),i.push(s)}catch(l){…}if(n&&pv(o)===pv(n))break;let a=nX.dirname(o);if(a===o)break;o=a}return i}
```

Its own error path names it `getProjectDirsUpToHome`. So a project skill is
resolved under `<cwd>/.claude` **and under every ancestor of it**, stopping at
the home directory, at the enclosing git repository's root — `P2_`, which is
null outside a repository — or at `/`.

For roma that is not a detail. `HOME` is `/home/node`, `ROMA_WORK_ROOT` defaults
to `/var/lib/roma/work`, and a Working Directory is `<work root>/<sessionId>`
made with `mkdirSync` and never `git init`-ed — so the climb meets no home
directory on the chain and no repository root to stop at, and runs to `/`. On
the way it stats `.claude/skills` under `/var/lib/roma/work`, `/var/lib/roma`,
`/var/lib`, `/var` and `/`. The first of those may be a mounted volume. **The
other four are the image's own filesystem, and a `COPY` can write any of them.**

**So the sentence this section used to end on is wrong, and the decision it
supported is not.** It read: *there is no path an image can bake a skill into
that a running roma would read.* There are four, and a skill baked into any of
them would be read. What that costs is a leg rather than the decision — "an
image cannot put anything there" was the mechanical half of rejecting the
`COPY`, and it has gone. The other half carries it alone and always could: a
skill is model-elected, caveman's description is trigger-phrase shaped, and
roma's Sessions supply no trigger. *Not the skill, because a skill is
model-elected* is unchanged, and its own summary — **yes, and it would not do
the thing** — is now the whole of the reason rather than the better of two.

Read off the binary and the image's own paths, not run: nothing here has watched
roma load a skill out of `/var/lib/roma/.claude/skills`, and the agenda below
gains that question.

**Measured — what an installed skill costs when nothing invokes it.** The
evidence this file cited for that — `/skills` rendering each entry as
`… · ${K} description tokens` — **is not in the pinned build.** The string
`description tokens` does not occur in the 2.1.220 binary at all. The claim is
re-established on better evidence, which is the listing itself rather than a
counter drawn beside it:

```js
function DMt(e){return e.whenToUse?`${e.description} - ${e.whenToUse}`:e.description}
function Why(e){let t=DMt(e),r=RMt();return t.length>r?t.slice(0,r-1)+"\u2026":t}
function qhy(e){…return `- ${e.name}: ${Why(e)}`}
function RMt(){return eo().skillListingMaxDescChars??Uhy}
…
Uhy=1536
```

An entry is `- name: description`, truncated at `skillListingMaxDescChars`,
whose own settings help calls it *"Per-skill description character cap in the
skill listing sent to Claude (default: 1536). Descriptions longer than this are
truncated. Raise to opt in to higher per-turn context cost."* The body is not in
it. caveman's frontmatter description is 404 characters and the body filtered to
one level is 4,107 — so the description is carried whole, well under the cap,
and the 4,107 is not carried at all. This is a stronger reading than the one it
replaces: a UI counter said what the build believed, and this is the string the
model is sent.

2.1.220 also takes a per-skill `name-only` override, which lists a skill without
its description. It does not rescue the installed-skill alternative below: it
would save the 404 characters by removing the only thing that could ever elect
the skill.

**Measured — the fork is the upstream.** `jackey8616/caveman` HEAD and
`JuliusBrussee/caveman` `main` are both `3098342`, and `git diff` between them
is empty. Pinning the fork buys the right to decide when the text moves. It buys
nothing else today, and this file says so rather than letting a future reader
infer that the fork was already carrying changes.

**Measured — the plugin runs third-party Node in the container.**
`.claude-plugin/plugin.json` declares `SessionStart` →
`src/hooks/caveman-activate.js` and `UserPromptSubmit` →
`src/hooks/caveman-mode-tracker.js`. The second runs before every Turn with the
prompt on stdin. Both write to `$CLAUDE_CONFIG_DIR`: `.caveman-active`,
`.caveman-active.prev`, `.caveman-history.jsonl`, `.caveman-mode-log.jsonl`.

**Measured — what the SessionStart hook actually does.** It reads `SKILL.md` at
runtime, strips the frontmatter, keeps only the active level's `| **level** |`
table row and `- level:` example lines, prefixes `CAVEMAN MODE ACTIVE — level: X`,
and writes the result to stdout as hidden SessionStart context. For `mode ===
'off'` it exits before any of that. So the plugin's whole trick is *put the
ruleset in the prompt*, which is a thing roma already has its own channel for.

**Measured — the values.** `VALID_MODES` is `off, lite, full, ultra,
wenyan-lite, wenyan, wenyan-full, wenyan-ultra, commit, review, compress`.
`wenyan` is an alias the hook rewrites to `wenyan-full`. `commit`, `review` and
`compress` are `INDEPENDENT_MODES`, for which the hook emits one line deferring
to a separate skill — skills this decision does not install.

**Measured — the append survives a `--resume`.** Agenda item 5, the one question
here no bundle could answer, and the assumption the whole decision rests on.
`#spawnNow` hands `appendSystemPrompt` to `ClaudeSession` without looking at
`resuming`, so the flag is on a resumed process's argv — which says nothing about
whether the Runtime applies it to a conversation that already has a system
prompt. `src/append-on-resume.live.test.ts` briefs a Session under one nonsense
codeword, ends it with `evict`, resumes it under a **different** one, and asks
for a codeword the inherited conversation never contained, so one run tells apart
the append applying, the original one persisting, and nothing persisting. It was
run on 2026-08-12 at `ab48d09`, two Turns for $0.118313, and both processes
reported **Claude Code 2.1.220** — which the run asserts rather than assumes,
going red rather than letting a reading span two builds:

```
verdict  append-applies — the append applies on resume — agenda item 5 answered yes
first    briefed ZARQUON-7413, said "BRIEFING-IN-FORCE"
resumed  briefed VELMOTH-2856, said "VELMOTH-2856"
spawns   resume=false resume=true
```

The resumed process answered with the codeword of the briefing **it was resumed
under**. So a Caveman applies for as long as a Session lives — across every
Eviction, Reaping, restart and swap — and `/caveman` reports a level the model is
on rather than one it abandoned at the first Eviction. This decision needs no
change, which is why nothing below was rewritten around it.

The reading is wider than the Caveman, and the failure it rules out was wider
still. The briefing was handed to the pool as an **announcement** — the same
argument a Reach announcement rides (`startup.ts`'s `eachReach`) — so what
survived the Eviction here is the channel itself, and ADR-0020's capabilities
survive it with the ruleset. `docs/append-on-resume-verification.md` is the
method and the reading in full.

**Not measured — that any of this saves a token.** The 65% is caveman's own
number, measured by a third party on prompts nobody here has seen, and it is
cited in this file as caveman's claim and never as roma's. What roma will be able
to say is in *The Audit Record carries the level* below.

**Not measured — whether the appended ruleset is cached.** It renders into
`system`, which is the stable half of a cacheable prefix, so it is the shape
prompt caching exists for. Whether roma's spawns hit that cache is a fact about
Claude Code's own request construction that nothing in this repository has ever
read, and the cost arithmetic below is stated without it.

**Not measured — wenyan.** Its own row in caveman's intensity table says
"80-90% character reduction — **chars, not tokens**". Characters are not what a
Shared Window is spent in. This is why two of its three levels are not on the
Menu.

**Not measured — Codex.** Everything below is Claude Code's. ADR-0026's rule
that everything roma pins for Claude Code it pins for Codex applies, and the
agenda item is at the end.

## Context

roma's agent talks to people through a Channel, and its Turns are billed to one
Shared Window the whole team shares (ADR-0002). Output tokens are the side of
that window a Task spends most of, and nothing in roma has ever asked the model
to spend fewer of them.

**caveman** is a third-party Claude Code Agent Skill that does exactly that: a
ruleset instructing the model to drop articles, filler and narration while
leaving code, errors and technical terms untouched. It claims 65% off prose
output. It ships as a skill, as a plugin, and as an installer.

The obvious reading of "can roma pre-install this skill?" is a `COPY` in the
Dockerfile. That reading does not survive — though not for the reason this file
first gave, which the re-read against 2.1.220 retired. An image *can* write a
directory a Session reads; what it cannot do is get the skill elected. Every
remaining shape is a real decision with a real cost, and this file is those
decisions.

## The decision

### A Caveman is a property of a Session, Pinned and Chosen

roma gains a **Caveman**: how short roma asks the model to be, carried on every
spawn. **One `ROMA_CAVEMAN` per deployment** — the Pinned Caveman, validated at
boot the way `ROMA_EFFORT` is, refusing a value it cannot serve and naming the
ones it can. **One Chosen Caveman per Session** where somebody has said so, kept
in the Work Root, returned to the Pinned Caveman by `/clear` without anything
being deleted.

The name is caveman's own, and that is a deliberate exception to the habit
`CONTEXT.md` otherwise keeps — Channel Adapter's `_Avoid_` list exists to stop
vendor words becoming roma's words. It is made because the values are caveman's
too (`lite`, `full`, `ultra`, `wenyan-full`), because the ruleset roma appends
says the word in its first line, and because a Caller who has met caveman
anywhere else arrives already typing `/caveman`. A roma-native word over
caveman's own values would have been a translation layer with nothing on the
other side of it.

**Optional, and a deployment that has not set `ROMA_CAVEMAN` is not changed by
this ADR at all.** ADR-0025 established that shape for Codex and the argument
transfers unedited: roma's required list is the Installation alone.

### Not the skill, because a skill is model-elected

Installing `SKILL.md` where Claude Code would find it does not make roma terse.
A skill contributes its **name and description** to the system prompt and waits
to be invoked; caveman's description is trigger-phrase shaped — *Use when user
says "caveman mode", "talk like caveman", "use caveman", "less tokens", "be
brief"* — and roma's Sessions are serving somebody's actual message, which
supplies no such trigger. The file would sit there, cost 404 characters of
description on every spawn, and change nothing.

That is the whole of the argument, and it is worth stating plainly because the
question this ADR answers was literally "can we pre-install the skill": **yes,
and it would not do the thing.**

### Not the plugin, because its hooks are a machine roma will not run

The plugin *does* work — its `SessionStart` hook puts the ruleset in the prompt
without waiting for an election. What it costs is third-party Node executing
inside roma's container on every Session start and, via `UserPromptSubmit`,
**before every Turn with the message text on stdin**. That container is the one
where an agent already runs arbitrary shell under the same uid that can read the
GitHub App's private key (README's `ROMA_GITHUB_PRIVATE_KEY_FILE` row records
that gap). And its state files land in `$CLAUDE_CONFIG_DIR` — the volume
ADR-0005 makes the only account of what an agent did and ADR-0006 says roma
deletes nothing from.

The Dockerfile's runtime stage argues its own package list line by line, on the
grounds that guessing produces an image nobody can explain, every line of it
attack surface on a public registry. A `UserPromptSubmit` hook that reads every
message anybody sends roma is not a line that survives that argument.

There is a second reason, smaller and sharper: `caveman-activate.js` branches on
the hook payload's `source` to tell a real startup from a resume, a `/clear` or a
compaction. roma spawns with `--resume` or `--session-id`, runs its own
compaction (ADR-0019) and answers `/clear` itself (ADR-0013). How those two
lifecycles interleave is unmeasured, and it is unmeasured about somebody else's
code.

### roma appends the ruleset through the channel it already owns

`ClaudeSession` already takes an `appendSystemPrompt` and puts it on `argv`
(`--append-system-prompt`). That is the same act the plugin's hook performs, on a
channel roma builds per spawn, stores nowhere, and can change without asking
anybody. The Chosen Caveman decides what goes in it.

This means `appendSystemPrompt` stops being a deployment-wide constant computed
once in `startup.ts` and becomes part of `SpawnTerms`, read at the moment of
spawning the way `#modelFor` and `#effortFor` already are — so a Chosen Caveman
written while roma was somewhere else is in force without anybody telling the
pool about it. A Session whose Caveman changes gets the pool's existing **`swap`**
with a fourth `reason`, and the comment on that event already says what that
costs: *an eviction is roma making room and this is money moving.*

### roma owns the text, because three of its lines describe a machine that is
not there

The ruleset roma appends is derived from caveman's `SKILL.md` at a pinned commit
of `jackey8616/caveman`, with three lines rewritten:

| line | why it goes |
| --- | --- |
| `Off only: "stop caveman" / "normal mode".` | The prose off-switch exists because `caveman-mode-tracker.js` watches `UserPromptSubmit` for that phrase. There is no tracker. Left in, roma's record would say `full` while the model had stopped, and `/caveman` would report a lie. |
| `Switch: /caveman lite\|full\|ultra\|wenyan-lite\|wenyan-full\|wenyan-ultra\|off` | Advertises seven values against a Menu of five. ADR-0023's consequence list names this failure exactly — *one carrying uppercase makes roma refuse a name it just offered* — and this would be the same failure by a different route. |
| `Default: **full**.` | Hardcodes a default that is `ROMA_CAVEMAN`'s to decide. |
| `"stop caveman" or "normal mode": revert.`, in `## Boundaries` | **Found when the text was written, not when this table was.** A *second* prose off-switch, which the first row's argument condemns exactly as well. The requirement is *no prose off-switch* rather than a count, so it goes; the carve-out on the same line stays. |

**All four describe the tracker hook**, which is the piece the section above
declines to install. Removing them is not editorial taste; it is deleting the
manual for a part that is not in the box.

The fourth row is here because the first three were written from a reading of
caveman's `## Persistence` section and the fourth line is in `## Boundaries`,
which nobody re-read until `src/caveman.ts` had to name every divergence. A table
that had stayed at three would have made the shipped text look like a mistake.

Everything else is kept verbatim **but for one parenthetical**, including the
line roma would probably not have thought to write: *Persisted outside chat:
write normal prose — code, comments, commits, docs, issue/PR/MR text, memory
files.* roma's agent opens issues and pull requests with `gh` (ADR-0008), and
that carve-out is the evidence the text is worth borrowing rather than replacing.
What goes with the fourth row is `(/caveman-compress exempt)`, on the switch
list's argument: that skill is one of the five siblings *Consequences* leaves
unclaimed, so the parenthetical would grant an exemption through a command
nothing answers.

Because roma owns it, `npx skills update` does not apply to it. The upstream file
is vendored beside the derived one as **evidence**, and a test holds its hash the
way `src/packaging.test.ts` holds a second copy of the Dockerfile's pins: moving
upstream turns the run red, and somebody decides.

### The ruleset is a TypeScript constant, and `off` is no text at all

`src/` holds no file that is not `.ts`, `build` is `rm -rf dist && tsc`, and the
runtime stage copies `dist/` — so a `.md` under `src/` would silently not ship,
and a `.md` anywhere else needs a `COPY` this image does not otherwise want. The
derived ruleset is therefore a constant in `src/`, one template plus roma's own
copy of caveman's fifteen-line level filter. One template rather than six
finished strings for the reason `ChosenRecord` is one class: the same idea
written once. Also because the rewritten `Default:` line has to name the Pinned
Caveman, which is a runtime value and cannot be a static string.

**`off` means the Session's `appendSystemPrompt` carries only `eachReach(...)`.**
Not the ruleset filtered to a level called off — that filter, run over caveman's
file with `off`, still produces 3,691 bytes of instructions. caveman's own hook
exits before filtering for exactly this reason, and roma does the same.

### The Menu is six wide, and two levels are the operator's alone

The **Caveman Menu** offers `off`, `lite`, `full`, `ultra`, `wenyan-full`, and
`default` — six, the same width as the Effort Menu, and under the ten buttons on
one message ADR-0023 declines to open. `wenyan` is not on it because it is an
alias. `commit`, `review` and `compress` are not on it because they defer to
skills roma does not install and would point at nothing.

`wenyan-lite` and `wenyan-ultra` are accepted by `ROMA_CAVEMAN` and never drawn,
which is `effort-menu.ts`'s existing move: *named here so that the one place
allowed to accept it — `ROMA_EFFORT`, read by an operator's hand — can do so.*
They are held back because wenyan's own row claims characters and roma spends
tokens, and a button roma cannot account for is a button roma should not draw.

### The Opening says it only when there is something to say

`#settingsReport` is one sentence with two readers — `/config` and the Opening —
and its comment argues against a second copy, so a third fact appears in both or
neither. It appears in both, **and only where the Session's Caveman is not
`off`**: ADR-0024 gives the Opening its job as telling somebody what they are on
when the answer is not obvious, and a deployment that never turns this on has
nothing to tell. The conditional tail is not a new shape on that sentence —
`#modelTakesNone` is already one.

The sentence's `Change either with` becomes `Change any with` when the third fact
is present, because *either* was only ever true of two.

### The Audit Record carries the level, and roma claims nothing until it does

An Audit Record carries `model` and `effort` because a cost nobody can attribute
to a setting is a cost nobody can read. A Caveman level is the same kind of fact
and goes on the record for the same reason — the third instance of that move and
the second in a week, since ADR-0027 has just put the Runtime there on the same
argument, and did it *while the value was still trivially true* rather than after
somebody needed it. This one is not trivially true from the day it lands, which
makes it the more urgent of the two.

`Turn.outputTokens` joins it. The value is already computed — ADR-0018's drift
check is its only reader today — and it is what makes the deployment able to
answer the question this whole ADR is built on, from its own traffic rather than
from a synthetic prompt.

Until it answers, **roma claims nothing**. The 65% is caveman's number. ADR-0016
already wrote the sentence this is a second instance of: pinning a thing *does
not change what happens, it makes roma able to say what happens.*

## Consequences

- **`appendSystemPrompt` moves.** It leaves the `SessionPool` constructor for
  `SpawnTerms`. Nothing else reads it, and the Reach announcements it already
  carries are unaffected — a Caveman is appended after them, on the blank-line
  rule `startup.ts` already applies.
- **A fourth `swap` reason.** `'caveman'` beside `'credential'`, `'model'` and
  `'effort'`. Its `from`/`to` are strings, so it joins the arm that already
  carries two — and an operator reading an unexplained respawn gets a fourth
  answer to *which*.
- **A third Chosen Record adapter.** `chosenCavemen` beside `chosenModels` and
  `chosenEfforts`. The entry in `CONTEXT.md` that says "used twice" is amended
  rather than left to rot.
- **A seventh Command, and the first whose spelling is nobody's build.** The list
  reached six one ADR ago (ADR-0027). Every spelling on it until now was Claude
  Code's own, claimed because a spelling roma leaves unclaimed is one somebody is
  billed for; `/caveman` is a third-party skill's, and it is claimed because
  people who met that skill elsewhere arrive already typing it. Same fault,
  longer route — and the first time that rule has been applied to a vendor roma
  does not ship.
- **`/caveman` is claimed, and its five siblings are not.** `/caveman-stats`,
  `/caveman-compress`, `/caveman-commit`, `/caveman-review` and `/caveman-help`
  stay unclaimed, so somebody who knows caveman from elsewhere and types one is
  billed for a Task that explains it. This is recorded rather than fixed, in the
  idiom ADR-0017 used for `/settings key=value`: a gap this ADR names and
  `commands.test.ts` pins.
- **"stop caveman" still works, and roma still cannot see it.** Removing the line
  from roma's text removes the instruction, not the phrase's effect on a model
  that has met caveman elsewhere. A Caller who types it gets a terser roma back
  on the next spawn with nobody having said so. Narrower than the alternative,
  not zero.
- **Nobody can measure this against the old numbers.**
  `docs/transcript-growth-verification.md` measured 7.7 kB per Session and the
  README sizes a disk from it. A deployment that turns this on has moved that
  number in a direction nobody has quantified. The figure is not re-derived here;
  it is named as stale-under-this-flag.
- **The Opening's sentence has two shapes.** A Caller who does `/caveman off` and
  then `/clear` returns to the Pinned Caveman and sees the sentence come back.
  That is correct and it will surprise somebody once.

## Alternatives considered

**Install the skill file.** Rejected on the measurement: model-elected, and
roma's Sessions supply no trigger. It is the reading of the original question and
it is the one that does nothing.

**Install the plugin, hooks and all.** Rejected on what runs: third-party Node
before every Turn with the message on stdin, in the container that can read the
App key, writing state into the Transcript volume. It is the only shape that
would have kept `/caveman lite|ultra|off` and `/caveman-stats` working as
caveman ships them, and that is what it costs.

**Install the skill and append a short nudge telling the model to use it.**
Rejected on arithmetic, which is the interesting part — it looks cheaper and is
not. With the skill installed, a Session that never uses caveman still pays the
description on every spawn, where the append pays nothing; and a Session that
does use it pays the description, the nudge, the body once invoked, *and* a Skill
tool call whose round trip is spent on the output side. There is no lazy case to
win: caveman has to shape the first sentence, so the body is loaded before the
first response or it is useless. The append is cheaper in both states.

**Append the ruleset unedited.** Rejected: see the table above. It would make
`/caveman` report a state the model had abandoned and make roma refuse two names
its own system prompt advertised.

**Append the ruleset and then a roma paragraph overriding it.** Rejected because
it is a bet that the later paragraph wins, and nothing in this repository has
measured that. Owning the text costs one hash-pinned test and wins outright.

**Ship it as a Reach.** Rejected on the glossary. A Reach is what roma can reach
on one provider; a Caveman reaches nothing. It would have been convenient —
`eachReach` already assembles the system prompt — and that convenience is exactly
the wrong reason to widen a term.

**Pinned only, no Chosen.** Considered seriously, and the argument for it is
real: the Shared Window is shared, so a Caller who opts out is spending
everybody's window. Rejected because the same is true of `/model opus` and
ADR-0014 allowed it anyway, and because a caveman roma cannot be talked out of is
a roma that cannot explain something carefully when somebody needs it to.

**`ROMA_CLAUDE_CAVEMAN` and `ROMA_CODEX_CAVEMAN` from the start.** Rejected on
ADR-0023's rule: *prefer changing it then to guessing now.* Codex is zero lines
of code. One variable today; per-Runtime the day there is a second Runtime.

## Verification agenda

Ordered by how much falls if the answer is no.

1. **Does the appended ruleset change roma's output tokens at all?** Everything
   else is decoration if it does not. Answerable from the deployment's own Audit
   Records once they carry the level and `outputTokens` — which is why that is
   part of this ADR and not a follow-up.
2. **Does a `.claude/skills` above the Work Root actually reach a Session?** The
   resolver stats every ancestor up to `/` and the image owns four of them, so
   the answer decides whether this image has a skill-shaped hole in it. Read off
   the binary, never run. This replaces the item asking whether the readings
   above held on 2.1.220 — they were re-read against it, which is how this
   question got asked.
3. **Is the append inside the cached prefix?** Decides whether the per-spawn cost
   is paid once or every Turn. Nothing in this repository has read Claude Code's
   request construction; this would be the first.
4. **Does `wenyan-full` cost fewer tokens than `full` on Chinese prompts?**
   Decides whether it earns a button. `npm run test:seam2` is the instrument, and
   it spends Shared Window money, so it is asked once and written down.
5. **Does `--append-system-prompt` survive a `--resume`? — asked and answered:
   yes, on 2.1.220.** It stays on the agenda with its answer rather than being
   deleted, because it is the item the rest of this file leaned on and a reader
   who wonders whether anybody checked deserves to find that they did.
   `src/append-on-resume.live.test.ts` is the instrument and
   `docs/append-on-resume-verification.md` the reading. Moving the pin re-opens
   it — that is what ADR-0007 means by a re-verification event — and re-running
   that one file is the whole of what re-opening costs.
6. **Does the app-server take a system-prompt append, and is any of this
   measurable on Codex?** ADR-0026's agenda gains this item; nothing here is
   blocked on it.
