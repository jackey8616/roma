# 17. roma claims `/config`, and answers with its own

Date: 2026-08-01

## Status

Accepted. Not yet implemented, and follows ADR-0016 — the report it gives has
nothing to say until a Session has an effort to report.

Applies ADR-0013's rule to two more spellings: `a spelling roma leaves unclaimed
is one somebody is billed for`. Applies ADR-0014's test to decide what the
claimed spelling should *do*.

### Verification status

Measured on the pinned build (2.1.220, ADR-0007) on 2026-08-01, in the same
credential-free harness ADR-0016 describes. Every case is `num_turns: 0`,
`total_cost_usd: 0`.

**Measured — `/config` is non-interactive on this build, and it sets things.**

```js
ic_  = {aliases:["settings"], type:"local-jsx", name:"config",
        description:"Open settings", argumentHint:"[key=value]", …}
iUs  = {type:"local", name:"config", aliases:["settings"],
        supportsNonInteractive:!0, description:"Set a setting by key",
        argumentHint:"key=value…"}
```

So ADR-0012's denylist case was right about this string, and this ADR is that
case being acted on rather than corrected.

**Measured — what each form does.**

| message | reply | side effect |
| --- | --- | --- |
| `/config` | the usage list: 35 settable keys | none |
| `/config theme=dark` | `Set Theme to dark` | writes the settings file under `CLAUDE_CONFIG_DIR` |
| `/config effortLevel=max` | `effortLevel isn't a /config setting. Run /config to see what's available.` | none |

The write was observed directly: a `settings.json.tmp.<pid>.<hash>` left in the
throwaway config dir by the atomic write, in a run killed mid-flight.

**Measured — the keys, and two of them matter more than the rest.** The list
includes:

```
model=default|sonnet|opus|haiku|best|sonnet[1m]|opusplan
workflows=true|false
workflowSizeGuideline=unrestricted|small|medium|large
permissionMode=default|plan|acceptEdits|auto|dontAsk
```

**Not measured — whether a relayed `/config model=…` actually moves a running
Session's model.** It was not measured because the decision does not turn on it:
what disqualifies relaying is that the write is deployment-wide and persistent,
which was observed, and that is enough.

## Context

`/config` is not a Command and not a Readout, so today it falls through to a
Task. `attribution.ts` puts the Caller Marker above it, Claude Code sees prose
rather than a command, the model answers plausibly about what `/config` might do,
and somebody is billed for it. ADR-0012 measured that shape at `$0.0549` for
`/context` and named `/config` in the same paragraph.

ADR-0013 has already ruled on this class:

> a spelling roma leaves unclaimed is one somebody is billed for

`/config` and its declared alias `/settings` are two more strings people arrive
already typing, because they are Claude Code's own.

**Relaying is out, and more firmly than ADR-0012 knew.** roma passes one
`CLAUDE_CONFIG_DIR` to every spawn (`ROMA_CLAUDE_CONFIG_DIR`, required since #34),
so a settings write from one Conversation is a write for **every Session in the
deployment**, persisting across restarts. And the key list is not a set of
cosmetic preferences: `model=…|sonnet[1m]|opusplan` is a second door onto exactly
what ADR-0014's Model Menu exists to bound, opening onto two things the Menu
deliberately withholds; `workflows` and `workflowSizeGuideline` are the switches
ADR-0016 keeps `ultracode` away from Callers for. A relayed `/config` would let
anyone who can message roma route around both boundaries, permanently, for
everybody.

So the question is not whether to relay. It is what the spelling should mean once
roma has taken it.

## Decision

**`/config` and `/settings` are Commands. With no argument roma reports what this
Session is set to. With an argument roma refuses, and names what it does let you
set.**

### Reporting is what the gesture can honestly mean

This is ADR-0014's test, applied unchanged:

> that one is `local-jsx`, a picker, and a picker has no form in a chat message.
> Reporting is what that gesture can honestly mean in a text channel, and roma
> can answer it without a process, without a Turn and without money, because it
> owns the answer.

Claude Code's no-argument `/config` is a settings panel. A panel has no form in a
chat message. What that gesture can honestly mean in one is *show me what this
conversation is set to* — and since ADR-0014 and ADR-0016, roma owns two answers
to that: the Chosen or Pinned Model, and the Chosen or Pinned Effort. It answers
from its own records, so the answer arrives with no process, no queueing behind a
running Task, and no money.

The alternative surfaced during measurement and was rejected: relay the bare
`/config` as a Readout so a Caller sees the build's real list of 35 keys. It is
read-only, non-interactive and free, so it would pass the Readout membership rule.
It is still the wrong answer, for two reasons. roma refuses every one of those 35
keys, so the list is a menu of things you may not have — strictly less useful in a
chat than being told what you are. And it cannot coexist with claiming the
spelling: `readCommand` answers before `readReadout` is consulted, so a `/config`
that is a Command head never reaches the Readout table at all. That ordering is
what ADR-0013 relies on to keep `/clear` out of reach, and it applies here whether
or not it is wanted.

### An argument is refused, by name, with the alternatives

`/config key=value` is refused rather than passed through, and the refusal names
`/model` and `/effort` as the two things roma does let a Conversation set.

Refused rather than allowed to fall through to a Task, because falling through is
the fault this ADR exists to fix — the Caller is billed for a sentence about their
settings change, and the settings change does not happen. Refused rather than
honoured, because honouring it means one Conversation reconfiguring every Session
in the deployment, past two boundaries that have ADRs of their own.

`/config` therefore joins `TAKES_AN_ARGUMENT`, which is now three entries:
`/model`, `/effort`, `/config`. ADR-0003 rejected prefix matching because such a
rule inherits every command a later release adds, and defended the alternative as
a named list that does not grow on its own. That is still true of the list and no
longer true of the observation that made it comforting: it has grown from one to
three in two ADRs, by hand, each time deliberately. The check on it is that adding
a string is an act somebody writes down — not that the number stays small.

### What is not closed

`/config foo bar` — a head and two words — is not a Command, because
`readCommand` treats two words after the head as a sentence rather than an
argument. It falls through to a Task and is billed as prose. This is the same
opening `/clear foo` has had since ADR-0013, left open there deliberately, and
claiming `/config` does not close it. Recorded rather than fixed, because closing
it means deciding what a multi-word argument would mean to roma, and it would mean
nothing.

## Consequences

- Two more spellings stop costing money to answer nothing. `/config` and
  `/settings` join `/clear`'s three.
- roma's `/config` and Claude Code's `/config` now do different things under the
  same name. Somebody who knows the tool will type it expecting a settings panel
  and get a two-line report — which is the intended trade, and the refusal on
  `key=value` is where the difference is explained rather than merely felt.
- The report duplicates what `/model` and `/effort` each say alone. That is
  deliberate: they are three spellings over two roma-owned facts, not three
  sources of truth, and none of them consults a process.
- A Caller can still reconfigure the whole deployment — by asking the agent to,
  in prose, since the agent has a shell. Nothing here is a boundary against the
  agent, for the same reason a Credential Shim is not one. What it bounds is the
  accident: somebody typing a command they know from the CLI and getting a
  deployment-wide change they did not know they were making.

## Alternatives considered

**Leave `/config` unclaimed.** Rejected. It is the status quo, it bills a model
Turn for every `/config` anybody types, and it answers with a guess.

**Claim it and only refuse.** Not wrong, and cheaper to build. Rejected because
roma has something true to say to that gesture and would be choosing to say
nothing.

**Relay the bare `/config` as a Readout.** Rejected above, on both the usefulness
of a menu of refusals and the `readCommand`-before-`readReadout` ordering.

**Relay `/config key=value` for a whitelist of harmless keys.** Rejected, though
it is the shape the Readout list would suggest. Every write goes to one shared
config dir, so even a harmless key is one Conversation changing a setting for
everybody, permanently — and the whitelist would need re-auditing against a key
list that a release can extend, which is the maintenance ADR-0012 already carries
once and should not carry twice for cosmetics.

**Give `/config` an argument that sets roma's own settings** — `/config
model=opus` as a synonym for `/model opus`. Rejected: it is a second spelling for
a Command that already exists, and it invites the reading that the other 34 keys
work too.
