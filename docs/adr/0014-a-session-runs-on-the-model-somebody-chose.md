# 14. A Session runs on the model somebody chose

Date: 2026-07-31

## Status

Accepted and implemented. `src/model-menu.ts` holds the Menu, `ChosenModels` in
`src/session-generation.ts` holds the record, and `src/session-pool.ts` maintains
the invariant on the swap it already had.

**Amended 2026-07-31**, to the evidence rather than to the decision, and marked
inline the way ADR-0002, ADR-0003 and ADR-0007 mark theirs. `yn()` was recorded
here as not readable statically; it is readable, and knowing so retires one of the
two jobs the seam 2 Menu check was given. Nothing that was built changes.

Builds on ADR-0013, which decides which string puts a Conversation back on the
Pinned Model by clearing it.

Takes ADR-0003's Commands in a direction it did not anticipate: roma gains a
third Command, and the first that takes an argument. The rule ADR-0003 wrote —
whole-message match, no prefix matching — is kept and narrowed rather than
dropped, and the sentence defending it stops being true. That is the third of
ADR-0003's Commands justifications to fall in two days, and, as with the other
two, the decision it defends stands.

### Verification status

This ADR was written entirely off `grep` against the pinned build's bundle
(2.1.220, ADR-0007). **`src/model-menu.live.test.ts` has since been run against a
real `claude -p` on that build**, which turns most of what it rested on from a
reading into a measurement. The evidence is in
[`docs/model-menu-verification.md`](../model-menu-verification.md); what follows
is only the part of it that bears on the decision.

**Verified**: that the id roma sends is accepted and echoed back as
`system/init.model`, which is what makes the Audit Record's spelling evidence of
what ran. That `/model` resolves each Menu entry, at `turns=0, cost=0`. That
`/model`'s non-interactive descriptor is the one that answers under `-p`, by
construction rather than by observation.

**Verified, and it corrected a reading**: the first-party alias table expands
`haiku` to the dated snapshot `claude-haiku-4-5-20251001` where `opus` and
`sonnet` stay undated. The Menu is unaffected and was not changed — it holds
undated ids uniformly and roma sends the id rather than the alias.

The consequence worth naming: every id on the Menu is an **undated alias**, so the
model behind it can be re-pointed upstream and the Audit Record will go on
spelling it the same way across that move. Accepted, because the alternative —
pinning dated snapshots — puts roma in the business of tracking model releases to
keep the Menu working at all. It is the same standing re-audit the Menu already
carries, and the check below is what surfaces it.

`PINNED_MODEL` is `claude-sonnet-5`, which is what `sonnet` resolves to. roma
pins the resolved id and a Caller would type the alias, so the two spellings have
to be understood as the same model.

The 2026-07-31 amendment is the one to read the lesson off, and the lesson is
worth more than the fact. "Not readable statically" was asserted here about a
minified bundle after one search that did not find it, and it survived into an
accepted ADR. `grep` failing to find something is evidence about the search.

**This does not reopen the decision; it sharpens the reason for it.** A relayed
`/model` is not expensive — it is free, and it works. What ADR-0012 measured at
`$0.0549` was the *other* shape, where the Caller Marker sits above the message so
Claude Code never sees a command at all. The reason roma owns the fact is the
clause the build supplies itself: **"for this session only"**. That setting lives
in the process, and Eviction, Reaping and a deploy all end processes at moments
`CONTEXT.md` defines as unobservable to the person using the Session.

**Measured — `/model`'s own `Available:` line ends `or a full model ID`.** So an
arbitrary model id is a legal argument upstream, and there is no list roma could
hold that would make validation complete — which is why the decision below is
about what roma *offers* rather than about what it can check. That line also names
three the Menu does not carry, which is the Menu behaving as an offer rather than
as a filter, and is worth re-reading when the pin moves.

**Still not verified — that `--model` and a relayed `/model` disagree after a
respawn.** The reasoning below rests on `--model` being a spawn argument
(`claude-session.ts:256`) and a respawn therefore re-applying it. That is roma's
own code and is certain; what is not measured is what Claude Code does with a
`/model` issued to a process that is later resumed under a different `--model`.
The build now says `for this session only` in its own words, which is the same
claim from the other side and is not the same as having watched a respawn. The
design avoids depending on the answer, so this stays unmeasured deliberately
rather than pending.

## Context

roma pins one model for every Session (`PINNED_MODEL`, overridable per
deployment by `ROMA_MODEL` at boot) and asserts it at startup. The pin is not
tidiness — ADR-0003 measured the model following the credential, and
`build-env.ts` records a stray `ANTHROPIC_API_KEY` moving a prototype from
`claude-sonnet-5` to `claude-opus-5[1m]` without a word.

What a team wants is narrower than what the pin forbids: to say, in one thread,
that this piece of work is worth a more capable model, and to have that stop
being true when the thread's context is cleared.

Three facts shape every option:

- **`--model` is fixed at spawn.** So is the environment. A Session's process
  cannot be moved between models while it lives.
- **Eviction and Reaping are unobservable by design.** `CONTEXT.md`: "nothing the
  person using it can observe changes."
- **Everybody draws on one Shared Window,** and the Audit Record carries no model
  at all. Which model a Task ran on is not recorded anywhere roma keeps.

Put the first two together and any design that hands `/model` to the process
produces a setting that silently reverts at a moment nobody can see: the choice
lives in a process, the process ends for reasons unrelated to it, and the next
one starts on the pin. The third says that when it happens, and while it has not
happened, nothing afterwards can tell which was which.

## Decision

**roma owns which model a Session runs on. `/model` is a Command, and is never
relayed.**

### The Chosen Model is roma's, and it is keyed by the Session id

A Session's Chosen Model is written to `<sessionId>.model` in the work root,
beside the `.generation` files.

Keyed by the Session id rather than by the Conversation Key, and the difference
is the whole of how reverting works. A Session id derives from the Conversation
Key and the Session Generation, and `/clear` moves the generation (ADR-0013,
ADR-0003) — so after a clear the id is different, no file exists under it, and
the Session is on the Pinned Model. **Reverting is arithmetic rather than an
action.** Keyed by Conversation Key it would be a deletion `/clear` has to
remember to perform, and forgetting it is precisely the failure this feature is
being built to avoid: the context is cleared and the model is still Opus.

This is `session-generation.ts`'s own trick, which `CONTEXT.md` states as "which
is why roma needs no database".

A file, not a directory, so `reclaimIdleWorkDirs` steps over it — it deletes
directories only. A Chosen Model therefore outlives the working directory's seven
days, as a generation does.

**Not in the working directory.** ADR-0008 has the agent cloning into it and
running `git add -A` there, so anything roma leaves would eventually be committed
into somebody's repository — the reason `--append-system-prompt` exists instead of
a file. It is also reclaimed at seven days, which would revert a Chosen Model
silently. Both are disqualifying on their own.

### `/model` is a Command that takes an argument, and only named strings may

`readCommand` gains one rule: a listed head may take an argument. The list holds
`/model` and nothing else. Every other string — `/stop`, ADR-0013's three, the
four Readouts — is matched whole, exactly as now.

ADR-0003 rejected prefix matching, and the rejection is kept:

> a prefix match would swallow commands that are not roma's, and would swallow
> more of them with every Claude Code release

What it rejected is a *general* rule, and the reason is growth: a rule keyed on
"begins with a slash and looks like ours" inherits every command a later release
adds. A named list of argument-taking heads does not grow on its own. It is the
Readout whitelist's shape — fails closed, and adding a string is a deliberate act
somebody has to write down.

The sentence ADR-0003 defends the whole-message rule with — "Neither of roma's two
takes an argument, so there is nothing this rule turns away that was meant for
roma" — becomes false here. The rule survives it; only the count does not.

**`/model` with no argument reports.** roma answers with the Session's current
model and the Menu. This is not a lesser version of Claude Code's no-argument
`/model`: that one is `local-jsx`, a picker, and a picker has no form in a chat
message. Reporting is what that gesture can honestly mean in a text channel, and
roma can answer it without a process, without a Turn and without money, because
it owns the answer.

### The Model Menu is roma's whitelist, not Claude Code's vocabulary

```
opus    sonnet    haiku    default
```

`default` means the Pinned Model, so a Conversation can put the model back
without clearing what it has said.

Not on it: the `[1m]` variants, and arbitrary full model ids. Upstream accepts
both.

This is a spending boundary rather than a typo filter, and it is named for the
reason `CONTEXT.md` names an Installation: a term that is the whole of a security
property should be a term. Everybody shares one subscription token (ADR-0002), so
a Session moved onto a costlier model spends a window the rest of the team is
standing in — and a thread is many people sharing one Session, so the person who
pays for the choice is usually not the person who made it. ADR-0002 already
refuses to let roma decide this class of question on an operator's behalf: metered
billing does not start at all without `ROMA_OVERFLOW_MONTHLY_CAP_USD`, because
"how much of your money roma may spend is not roma's to decide". A `/model` that
accepted anything would open, to anyone who can send a message, a door the
operator had to unlock by hand next to it.

A whitelist also makes the check **local and immediate**, which is the second
reason and nearly as strong. roma can refuse an unknown name in the reply to the
message that contained it, addressed to the person who typed it. There is no
complete check available otherwise — "or a full model ID" means no list is
exhaustive — so the alternative is not a later check but no check, and the failure
surfaces as a process that will not start, on somebody else's next message, in a
thread where they did not type anything.

### The process changes at acquire, on the swap that already exists

`session-pool.ts` already solves this problem for the credential, which is fixed
at spawn for the same reason the model is:

> The Session is resident on the credential this Turn is not to be paid for by.
> The process goes before the next one starts — not because the old one is in the
> way, but because two processes on one transcript corrupt it, and "alive but
> idle" is not a state anybody has measured as safe.

A Resident records the model it was spawned on. Acquiring a Session for a Turn
whose model differs ends the process and spawns a new one, resumed, on the Chosen
Model. Nothing new is invented, and no new failure mode is taken on.

**`/model` itself tears nothing down.** It writes the file and answers. A Task
already running finishes on the model it started under and still answers the
person who asked — which is `/clear`'s behaviour (`core.ts:461`) and is the right
one for the same reason: a Command aimed at what the *next* message reaches
cannot also reach backwards into work somebody is waiting on.

The consequence has to be said out loud in the reply, though: **from your next
message.** A bare acknowledgement while a Task is running would be read as having
changed the Task that is running.

Stating it as an invariant the pool maintains, rather than as an effect `/model`
performs, is deliberate. It cannot be forgotten by a later caller, and it is
re-established for free after a restart, because the pool reads the Chosen Model
from disk at spawn the way it already reads `resuming` from `existsSync(cwd)`.

### What is written down

**The Operator Log's `swap` gains a reason.** It already exists for the
credential, and already explains itself as "money moving" rather than as roma
making room. A model change is money moving by the same argument, and the two
differ only in what prompted them — which is exactly how `evict` and `reap`
already share one shape:

```
readonly event: 'swap'
readonly reason: 'credential' | 'model'
```

**The Audit Record gains the model.** Optional, and read as the Pinned Model when
absent. The Q7 argument requires it: a decision whose whole justification is that
nobody can see afterwards which model spent the shared window does not get to
leave that unrecorded. Optional rather than required for the reason `callerName`
is (`audit-log.ts`): `readRecord` drops a line it cannot parse, a dropped line
leaves the month's total, and the month's total is what the Overflow cap is
enforced against — so a required field would silently reset the month across the
deploy that added it.

### The Menu is tied to the pin, twice

**In the drift report, by naming the version.** The file holding the Menu carries
the pinned Claude Code version, so `scripts/claude-code-drift.ts` — which greps
the working tree for files naming the pin and reports them under "What currently
rests on 2.1.220" — lists it without being taught to. `src/readouts.ts` gets the
same line, which closes the gap ADR-0012 recorded and left open:

> roma now has a list that must be re-audited whenever the ADR-0007 pin moves.
> Nothing enforces that

It still does not *enforce* it. What changes is that the re-audit list stops being
something somebody has to remember and becomes something the report already
prints.

**In seam 2, by measuring.** A check spawns the pinned binary twice per Menu entry
and reads `system/init.model` — the same field the Startup Self-Check already
asserts on, parsed by the same `stream-events.ts`. Twice rather than once because
the two things it has to say are different in kind: that the **id** roma sends is
accepted and echoed, which is roma's own invariant and is asserted as equality,
and that the **alias** a Caller types still means that model, which is a fact
about a build roma does not control and is asserted only as the id or a dated
snapshot of it. ~~It also settles `yn()`, which cannot be read statically.~~ —
struck 2026-07-31: `yn()` is `!Mt.isInteractive`, so it is settled by reading and
this check no longer carries that second job. See the amendment above.

Run once against 2.1.220, which is what the verification section above now
reports. That run is also where the one-spawn version of this check earned its
second spawn.

**It cannot live in CI**, and that is not a preference. `src/packaging.test.ts`
sweeps every workflow and the whole of `scripts/` for `CLAUDE_CODE_OAUTH_TOKEN`,
`test:seam2` and `.live.test`, and its own comment names this exact case:

> It is also the pattern that catches the version of this that is not a mistake,
> which is a release job "proving the image works" by booting roma for real.

So it belongs beside the other things a human runs on purpose when the pin moves,
which ADR-0007 already makes a re-verification event rather than a bump.

## Consequences

- The domain model gains three terms and roma gains a third Command. `CONTEXT.md`
  gains **Pinned Model**, **Chosen Model** and **Model Menu**.
- Changing model costs a cold start. Judged cheap: it is a deliberate, infrequent
  act by somebody about to ask for something substantial, and Eviction already
  charges the same price to people who did not ask for anything.
- Every `/clear` leaves a `.model` file under a Session id nothing will use again.
  Files are never reclaimed — that is what keeps `.generation` safe — so this
  litter accumulates at tens of bytes per clear, forever. Accepted over a deletion
  that has to be remembered.
- The Menu is a person's judgement, re-audited when the pin moves. Same standing
  risk as the Readout whitelist, and now at least both appear in the same report.
- A Caller can move a Session onto a costlier model, and the people sharing that
  thread will not be told. The Audit Record makes it answerable afterwards; nothing
  announces it at the time. Whether it should is a question this ADR leaves open
  rather than settles — there is no usage data to argue it with yet, which is the
  same reason the Menu holds no per-model ceremony.
- `ROMA_MODEL` keeps meaning what it means: it moves the Pinned Model for a
  deployment. A Chosen Model overrides whatever that resolved to, and `default`
  returns to it rather than to `claude-sonnet-5`.
- The Startup Self-Check is unaffected. It proves the deployment boots on its
  Pinned Model, which no Chosen Model can reach — a Chosen Model belongs to a
  Session, and the self-check's probe is not one.

## Alternatives considered

**Relay `/model` to the process, as a Readout.** Rejected, and it is the option
the feature looks like from the outside. It fails on Eviction: the choice lives in
a process, the process ends for reasons the Caller cannot observe, and the next
one starts on the pin. The result is not model switching but a setting that
reverts at random. It is also refused by the Readout membership rule as written —
"changes no state of the Session or of Claude Code" — and ADR-0012 names `/model`
specifically as a string that must not be relayed.

**Relay it *and* remember it,** so a live process switches without a cold start
and the choice is re-applied at the next spawn. Rejected, though it is the only
option that avoids the cold start. It leaves roma with two answers to "what model
is this Session on" and no way to tell when they disagree — a relay that failed,
an argument Claude Code rejected, or `yn()` resolving to the picker would each
produce a roma that believes something the process does not. ADR-0002's account of
who paid for what, and the Startup Self-Check's whole reason for existing, both
rest on roma being able to say one certain thing about the model.

**Separate argument-free Commands: `/opus`, `/sonnet`, `/haiku`.** Rejected,
though it preserves ADR-0003's rule untouched and is the cheapest thing to build.
It writes the Menu into the Command surface, so a new model is a new Command; it
cannot express `default` as anything but a fourth; and it is not the gesture that
was asked for, which was Claude Code's.

**Accept any model name and let Claude Code judge it.** Rejected above, on both
counts: it is the spending decision, and it converts a typo into a process that
fails to start on the next person's message.

**A per-model gate, like Overflow's.** Not rejected — deferred. It presumes Opus
is worth a ceremony, and roma has no figure to argue that with, because the model
has never been on an Audit Record. Record the model first, then look.

**A free-run check that greps the alias table out of the bundle.** Rejected. It
would block a release, which is more than the drift report does, but it watches a
minified object literal with no stability contract — and `claude-code-drift.ts`
opens with the argument against it: "a check that passes forever while watching
nothing, and a green tick reads as 'the pin is current'". The version that fails
loudly instead fails on every unrelated reshuffle of that literal, and a check
people mute is a check that has stopped watching.

**`/resume` and `/compact`, asked for alongside this.** `/resume` is dropped: it
is `local-jsx` with no `supportsNonInteractive`, so it cannot run in `-p` at all,
and roma already resumes every Session on every message — the word names nothing
roma lacks. `/compact` is deferred to its own ticket: it is non-interactive and
free-looking, but it summarises, which drives a Turn and changes the Session — so
it is neither a Command, nor a Readout by the membership rule, nor usable as a
Task, which would show it to the model as prose. It needs the fourth kind of
inbound message ADR-0012 declined to invent, and it shares no parts with this.
