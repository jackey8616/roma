# 16. A Session runs at the effort somebody chose

Date: 2026-08-01

## Status

Accepted and implemented — the measurements below were taken first,
deliberately, and the build followed. `src/effort-menu.ts` holds the Menu and the
Matrix, `ChosenEfforts` in `src/session-generation.ts` holds the record,
`src/session-pool.ts` maintains the invariant on the swap it already had, and
`scripts/claude-code-effort-matrix.ts` is the extractor. Run against 2.1.220 it
reproduces the three gates quoted below by name, `claude-mythos-5` on the
allowing branch included.

Repeats ADR-0014's shape for a second per-Session setting, and the repetition is
the point: `/effort` fails as a relay for the same reason `/model` does, and the
machinery that solved it is already here. What is **not** repeated is how roma
knows the setting took. `--model` is echoed in `system/init` and the Startup
Self-Check asserts on it; `--effort` is echoed nowhere at all, and most of this
ADR is about what roma does instead.

Corrects nothing in ADR-0012, and confirms it. ADR-0012's case against a denylist
named `/config key=value` and `/effort` as free, non-interactive commands that
would pass a "drives no Turn" rule and must not be relayed. Both claims are true
on the pinned build; both were re-measured here.

### Verification status

Everything below was measured on the pinned build (2.1.220, ADR-0007), against
the binary in this repo's own container, on 2026-08-01, before any of this was
built. The evidence is in
[`docs/effort-menu-verification.md`](../effort-menu-verification.md); what
follows is the part of it the decision rests on.

Every case reported `num_turns: 0` and `total_cost_usd: 0`: **nothing in this ADR
cost anything to establish.** That is a fact about `/effort` and `/config` rather
than about the care taken, and it is what makes the build-time check below
possible at all.

**Measured — `/effort` is a command on this build, with `/model`'s two-descriptor
shape**, and under `-p` the non-interactive one answers. `/effort current` returns
a report and `/effort <level>` returns `Set effort level to <level> (this session
only)`.

**Measured — the levels.** `["low","medium","high","xhigh","max"]`, one alias
(`med` → `medium`), and `ultracode` → `xhigh` — so `ultracode` is not a sixth
level.

**Measured — `--effort` lands and `/effort current` echoes it**, for every level
and for `ultracode`. With no `--effort` at all the build reports `Effort level:
auto (currently high)`, which settles the default: this build's own fallback is
`high`, and that is what makes `ROMA_EFFORT`'s default below behaviour-preserving
rather than a quiet change.

**And an unrecognised one is the failure mode the whole design is arranged
around. `--effort bananas` does not fail the spawn.** It warns on stderr, the
process starts, and it runs on the default — so roma can be wrong about the
effort of every Session it serves and nothing stops.

**Measured — `system/init` carries no effort field.** It carries `model`, which
is what the Startup Self-Check asserts on, and there is no counterpart for
effort. This is the whole reason `/model`'s solution does not carry over intact.

**Measured — the precedence, and it closes two holes.**
`CLAUDE_CODE_EFFORT_LEVEL` > `--effort` > `settings.effortLevel`. Two
consequences, both load-bearing:

- **Passing `--effort` on every spawn closes the settings file.** The config dir
  is one per deployment (`ROMA_CLAUDE_CONFIG_DIR`), so an `effortLevel` left in it
  would otherwise set the effort for every Session in roma, invisibly.
- **`buildEnv`'s allowlist closes the environment variable.** `PASSTHROUGH` is
  `PATH, HOME, USER, SHELL, LANG, TMPDIR` and nothing else, so a host
  `CLAUDE_CODE_EFFORT_LEVEL` cannot reach a Session. That allowlist was written
  for credentials. It turns out to be the only thing standing between the host
  environment and roma's effort, and it should not be narrowed without reading
  this line.

**Measured — none of it needs a credential.** With the environment stripped to
exactly `buildEnv`'s `PASSTHROUGH` plus a fresh config dir — no `ANTHROPIC_*`, no
proxy, no OAuth token, no inherited `CLAUDE_*` — every case above still answers,
at `apiKeySource: "none"`, `num_turns: 0`, `total_cost_usd: 0`. This is what makes
the build-time check below legal under `src/packaging.test.ts`, which forbids CI
from carrying `CLAUDE_CODE_OAUTH_TOKEN`, `test:seam2` or `.live.test`. The check
needs none of the three.

**Measured, and it is the finding that changed the design — the echo reports what
was *stored*, not what the model will *use*.** `claude-haiku-4-5` spawned with
`--effort xhigh` reports `xhigh`. It also reports `max`. Every level, on every
model, comes back identical, so the echo cannot be used to tell a level that
landed from one that was accepted and discarded.

**Read — the gate the echo cannot see.** The request builder deletes `effort`
from the request for a named list of models, `claude-haiku-4-5` among them. So on
haiku the effort is dropped and nothing observable says so. Corroborated by the
build's own user-facing text: `xhigh` describes itself as `Deeper reasoning than
high, just below maximum (Fable 5, Opus 4.7+, Sonnet 5)` — haiku is not among
them.

**Not measured, and not measurable — what actually goes on the wire.** The one
thing that would settle it is the request body, and roma never sees one. Every
claim about that gate is a *reading of a binary*, and it is written down as one.

**Not measured — the server-side ceiling.** `kQt()` reads `maxEffortLevel` from
the entitled-models response, and `YCe()` clamps a level down to it. No clamping
appeared in any of the fifteen model × level cases, so this account has no ceiling
in effect and there was nothing to observe. It remains the one failure mode
nothing here watches.

**Not verified — `--permission-mode bypassPermissions`.** Omitted for the reason
ADR-0012 omits it: the flag is refused to root and this container runs as root,
where roma's does not.

## Context

roma has never said what effort its Sessions run at, and they have always run at
one. It comes from Claude Code's own default, or from an `effortLevel` in a
settings file under the config dir every Session shares — a file roma neither
writes nor reads, and which an operator can change without roma noticing or a
deploy happening.

That is the shape ADR-0003 already found once, in the model:

> ADR-0003 measured the model following the credential, and `build-env.ts`
> records a stray `ANTHROPIC_API_KEY` moving a prototype from `claude-sonnet-5`
> to `claude-opus-5[1m]` without a word.

What a team wants on top of that is narrower: to say, in one thread, that this
piece of work deserves more thinking, and to have that stop being true when the
thread is cleared. Which is exactly what ADR-0014 built for the model, down to
the file it would live beside.

The obvious move is to relay `/effort` as a Readout. It is `type:"local"` with
`supportsNonInteractive:!0`, it drives no Turn, it costs nothing, and it works.
It is also the wrong move for the reason ADR-0014 already wrote down, and the
build says so in its own words: `Set effort level to max (**this session
only**)`. A session is a process. Eviction, Reaping and a deploy all end
processes at moments `CONTEXT.md` defines as unobservable to the person using the
Session. Relayed, `/effort` is not a setting; it is a setting that reverts at a
time nobody can see.

## Decision

**roma owns the effort a Session runs at. `/effort` is a Command, and is never
relayed.**

### Every Session carries an effort, and roma can name it

`ROMA_EFFORT` fixes the **Pinned Effort** before boot and roma passes `--effort`
on every spawn, including for the Sessions nobody has touched. Optional, and
defaulting to `high`.

`high` rather than anything else because the point of this half is **visibility,
not change**: `high` is measured above as what the build already falls back to, so
a deployment that adopts this runs exactly as it ran yesterday and gains the
ability to say so. Choosing `medium` here would have smuggled a quiet downgrade
into the same commit, at a moment when the Audit Record has no effort history to
notice it with. If a deployment should think less, that is an operator reading
their own ledger and moving `ROMA_EFFORT`, not this ADR.

Optional rather than required, which is the opposite of what
`ROMA_OVERFLOW_MONTHLY_CAP_USD` does. The difference is what the variable
authorises: the Overflow cap opens a **new** way to spend money, so ADR-0002 will
not let roma assume consent for it. Effort is money already being spent under
another name. Requiring the variable would stop every existing deployment from
booting in exchange for a signature on a default they are already paying for.

`ROMA_EFFORT` is validated at startup against roma's own levels, locally, with no
process involved. It is the one wrong-effort failure that needs no measurement to
catch, and the `bananas` row above is what it costs to miss it.

### The Chosen Effort is roma's, and it is keyed by the Session id

`<sessionId>.effort` in the work root, beside `.model` and `.generation`. Every
argument ADR-0014 makes for that placement holds unchanged and is not repeated
here: reverting on `/clear` is arithmetic rather than an action, a file survives
`reclaimIdleWorkDirs` because it deletes directories only, and nothing may go in
the working directory because ADR-0008 has the agent committing its contents.

`session-pool.ts` maintains the invariant on the swap it already has. A Resident
records the effort it was spawned on as well as the model; acquiring a Session for
a Turn whose effort differs ends the process and spawns a new one, resumed. No new
failure mode is taken on, and `swap`'s `reason` gains a third value.

### The Effort Menu holds every level, and `ultracode` is not one

```
low    medium    high    xhigh    max    default
```

All five, which is deliberately unlike the Model Menu. The Model Menu withholds
models because a costlier model is a bigger share of a window everybody stands in
and roma cannot check what it hands over. Neither reason survives here: the levels
are enumerable, they are all Claude Code's own, and a Caller asking for more
thinking on a task they are about to wait for is the feature rather than the
risk.

**`ultracode` is off the Menu and reachable only through `ROMA_EFFORT`.** It is
not a level — `hBc = {ultracode:"xhigh"}` — it is `xhigh` plus dynamic workflow
orchestration, which the build describes as turning one Task into a fleet. That is
a different kind of spend from thinking longer, on a window everybody shares, in a
thread where one person's choice is paid for by the others. The operator may pin
it, because the Menu bounds Callers and never the operator: `ROMA_MODEL` can
already name a model off the Model Menu, and `menuNameFor()` returning `null` is
that case already handled. Whether a Caller may reach it is deferred to its own
ticket, and deliberately deferred to **after** the Audit Record has effort on it —
which is ADR-0014's own reason for deferring the per-model gate: *record the model
first, then look.*

**`auto` is not on the Menu because it cannot be.** `--effort auto` is rejected by
the CLI parser (`uJn` → `uHt` → `AWr`, and `auto` is in neither table), so it
warns and is ignored. The only way roma could offer it is by omitting `--effort`
— which reopens the settings file the previous section closed. It is not refused;
it is incompatible with pinning, and pinning won.

### The Effort Matrix is read from the binary before the image ships

A script under `scripts/`, run when the ADR-0007 pin moves, extracts which models
the pinned build strips effort from, and its output is reviewed by a person and
committed as a constant.

It anchors on the **server-side feature-flag names** — `Ede(e,"effort")`,
`"xhigh_effort"`, `"max_effort"` — rather than on minified identifiers, because
the flag names are a contract with something and the identifiers are renamed every
build. Against 2.1.220 it yields, for roma's Menu:

| model | takes effort | xhigh | max |
| --- | --- | --- | --- |
| `claude-opus-5` | yes | yes | yes |
| `claude-sonnet-5` | yes | yes | yes |
| `claude-haiku-4-5` | **no** | no | no |

**It reports; it does not gate.** Nothing fails a build on it, nothing in CI
watches it, and roma refuses nothing because of it. This is `claude-code-drift.ts`'s
posture — "enumeration rather than enforcement" — and it is not modesty. While
writing this ADR the first version of the extractor opened its window too wide,
read into the neighbouring function, and reported `claude-mythos-5` as
unsupported when it is on the allowing branch. That failure was silent and would
have stayed silent. An extractor that can do that must print for a human, not
decide for a machine.

roma uses the Matrix for exactly two things:

- **It says so.** `/effort` on a Session whose model takes no effort, and `/model`
  onto such a model from a Session that has a Chosen Effort, both say in their
  reply that the setting will not apply until the model changes.
- **It records so.** The Audit Record says the effort did not apply, rather than
  naming a level nothing ran at.

**It refuses nothing.** Setting `max` on haiku costs no more than `low` does —
the harm is a false belief, and a false belief is answered with a sentence. The
Model Menu is a spending boundary; this is not one, and dressing it as one would
be borrowing authority the facts do not support.

### Roma asks the process once, at boot, and does not block on the answer

The Startup Self-Check's probe is a real process spawned with roma's real
arguments. After the credential and model assertions, roma relays `/effort
current` to it and compares loosely — the level word anywhere in the message,
case-insensitively, rather than the sentence's shape. A disagreement is written to
the Operator Log. **Boot continues.**

Not blocking, and this is the sharpest trade in the ADR. Every other self-check
condition reads a structured field: `apiKeySource`, `model`, `num_turns`. This one
reads English prose in at least three shapes, one of which embeds a description
table. Making a deployment refuse to start on a sentence a release could reword is
paying with an outage to catch a fault whose worst outcome is thinking at the
wrong depth. The Operator Log is where an anomaly goes — ADR-0012's drift check
already writes a misbehaving Readout there for the same reason, and the loose
match exists so the line fires on a changed *level* rather than on changed
*prose*, because a check people learn to ignore has stopped watching.

**Once, at boot, and not on every spawn.** Per-spawn verification was decided and
then withdrawn when the precedence measurements came in: with `--effort` beating
the settings file and `buildEnv` blocking the environment variable, a per-spawn
echo had nothing left to catch but the server-side ceiling, which is inert on this
account and which the echo would only see by accident. What boot proves is
**roma's own wiring** — that `--effort` really is in the spawn arguments and
`ROMA_EFFORT` really resolved to what roma thinks. That is a roma failure class
rather than a Claude Code one, it is worth one relay per deployment, and it costs
nothing.

### What is written down

**The Audit Record gains the effort, and says how well it is known.** ADR-0014's
argument requires it: a decision whose justification is that nobody can see
afterwards what spent the shared window does not get to leave that unrecorded.

But it is weaker evidence than the model beside it and must not be spelled as
though it were. The model on a record was echoed by the process that ran the
Turn; the effort is what roma sent, boot-verified once, and interpreted through a
Matrix read off a binary. Where the Matrix says the model takes no effort, the
record says **that** rather than naming a level. Optional, and absent read as
**unknown** rather than as the Pinned Effort — because a record written before
this field existed ran on whatever that shared settings file happened to say, and
roma genuinely does not know what that was. Labelling those retroactively would
be inventing a fact, which is the discipline `costUsd` already keeps by
distinguishing free from unpriced.

Optional rather than required for the reason `callerName` and `kind` are:
`readRecord` drops a line it cannot parse, a dropped line leaves the month's
total, and the month's total is what the Overflow cap is enforced against.

**The Menu and the Matrix are tied to the pin by naming the version.** The file
holding them carries the pinned Claude Code version, so `claude-code-drift.ts`'s
working-tree sweep lists it under what rests on 2.1.220 without being taught to.
`src/readouts.ts` and `src/model-menu.ts` already carry that line. This is the
third, and the re-audit list is now long enough that "somebody remembers" has
stopped being the mechanism.

## Consequences

- The domain model gains four terms: **Pinned Effort**, **Chosen Effort**,
  **Effort Menu**, **Effort Matrix**. roma gains a fourth Command, and
  `TAKES_AN_ARGUMENT` a second entry — a third with ADR-0017.
- Changing effort costs a cold start, on the same swap changing model already
  costs one for.
- Every `/clear` leaves a `.effort` file under a Session id nothing will use
  again, at tens of bytes per clear, forever. The same litter `.model` already
  leaves, accepted for the same reason: a deletion that has to be remembered is
  worse than a file that is never read.
- **A Session on `claude-haiku-4-5` cannot use effort at all**, and roma will say
  so rather than prevent it. If that becomes annoying rather than informative, the
  answer is a ticket about the Model Menu, not a refusal here.
- **The server-side ceiling is watched by nothing.** If an account gains a
  `maxEffortLevel` below what a Caller picks, Claude Code clamps it and roma goes
  on reporting the level that was asked for. Named here because it is the one
  hole this design leaves open, and it is open because the only observation of it
  is a clamp that has never been seen.
- The build-time extractor is a new thing that must be re-run when the pin moves,
  and it can be silently wrong. It joins the Readout whitelist and the Model Menu
  on the re-audit list, and unlike those two it produces its own output for
  review rather than requiring somebody to go and read a binary.
- `buildEnv`'s `PASSTHROUGH` allowlist quietly became load-bearing for something
  other than credentials. Narrowing it is now a decision about effort as well.
- Nothing here gives a Caller a way to know an effort was applied. The reply says
  what roma set and, where the Matrix knows better, that it will not apply. It
  never says the model thought harder, because roma cannot see that.

## Alternatives considered

**Relay `/effort` as a Readout.** Rejected on ADR-0014's argument, which the
build states from its own side: `this session only`. The setting lives in a
process, processes end unobservably, and the result is not effort switching but a
value that reverts at random. It is also refused by the Readout membership rule as
written — "changes no state of the Session or of Claude Code".

**Relay it *and* remember it.** Rejected for the reason ADR-0014 rejects it for
the model: two answers to one question and no way to tell when they disagree.
Worse here than there, because there is no `system/init` field to adjudicate.

**Verify on every spawn.** Decided, then withdrawn on measurement. Once the
precedence table showed `--effort` beating the settings file and `buildEnv`
blocking the environment variable, the per-spawn echo's remaining catch was a
ceiling nobody has observed. It was paying a relay on every cold start to watch
something inert.

**Refuse a level the Matrix says will not apply.** Rejected. It costs nothing to
set `max` on haiku, so there is no spending boundary to enforce; the whole harm is
a misunderstanding, and a sentence fixes a misunderstanding. Refusing would also
give the Matrix — a reading of a minified binary that has already been wrong once
— the authority to turn away something a Caller asked for.

**Hold a per-model, per-level support table and validate against it.** Rejected
before the build-time extractor existed, and the rejection is what the extractor
is a reply to. A hand-held table grepped from `I_e`/`eqe` would watch minified
internals with no stability contract — ADR-0014's argument against the free-run
alias check — *and* be incomplete anyway, because the server-side ceiling is not
in the binary. What survived is narrower: one fact per model (does it take effort
at all), extracted rather than transcribed, reviewed rather than trusted, and used
to speak rather than to refuse.

**Block startup when the effort echo disagrees.** Rejected above: an outage is too
much to pay for a reworded sentence.

**A Pinned Effort of `medium`, or a required `ROMA_EFFORT`.** Both rejected above
— the first smuggles a downgrade nobody can see, the second stops existing
deployments booting to collect a signature on a default they already pay for.

**Leave effort alone entirely.** Rejected, and worth stating plainly: the status
quo is not neutrality. Every Session already runs at an effort, chosen by a file
roma does not read, changeable without a deploy, and unrecorded on every Audit
Record roma has ever written.
