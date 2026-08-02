# Verification: which command spellings the pinned build declares

Date: 2026-08-01
Status: **mixed, deliberately.** The `/clear` half is a `grep` against a minified
bundle and establishes only that the strings exist and how Claude Code groups
them. The `/config` half was run, and includes an observed write.

Measured on: the pinned build (2.1.220, ADR-0007), in this repo's container. The
`/config` cases were run in the credential-free harness ADR-0016 describes, and
every one of them is `num_turns: 0`, `total_cost_usd: 0`.

Extracted from ADR-0013's and ADR-0017's `Verification status` sections on
2026-08-02. The readings and their prose are unchanged; what moved is where they
live. Both ADRs keep the findings that bear on their decisions and link here for
the evidence, in the shape ADR-0011 uses.

The two are together because they are one subject: what this build calls the
spellings roma claims, and what it would do with them if roma did not. Neither
set justified a file of its own.

## Read — the reset descriptor (ADR-0013)

```
{type:"local", name:"clear",
 description:"Start a new session with empty context; previous session stays on disk",
 aliases:["reset","new"], supportsNonInteractive:!0}
```

So `clear` is the name and `new` is one of two aliases on it. roma answers to the
alias and not to the name.

**Weaker evidence than ADR-0012's, and the difference is worth naming**: that ADR
ran the binary and read the stream. This is a minified object literal. It is
enough to establish that the strings exist and how Claude Code groups them, and
it is not enough to establish behaviour.

## Read — `/stop` collides too (ADR-0013)

```
{type:"local", name:"stop", supportsNonInteractive:!0,
 description:"Stop this background session; transcript and worktree are kept"}
```

roma's `/stop` shadows it. Recorded because it is the same class of fact and
somebody will find it later; nothing changes because of it, since the two mean
close enough to the same thing that shadowing is the outcome anybody would want.

## Measured — `/config` is non-interactive on this build, and it sets things (ADR-0017)

```js
ic_  = {aliases:["settings"], type:"local-jsx", name:"config",
        description:"Open settings", argumentHint:"[key=value]", …}
iUs  = {type:"local", name:"config", aliases:["settings"],
        supportsNonInteractive:!0, description:"Set a setting by key",
        argumentHint:"key=value…"}
```

So ADR-0012's denylist case was right about this string, and ADR-0017 is that
case being acted on rather than corrected.

## Measured — what each form of `/config` does (ADR-0017)

| message | reply | side effect |
| --- | --- | --- |
| `/config` | the usage list: 35 settable keys | none |
| `/config theme=dark` | `Set Theme to dark` | writes the settings file under `CLAUDE_CONFIG_DIR` |
| `/config effortLevel=max` | `effortLevel isn't a /config setting. Run /config to see what's available.` | none |

The write was observed directly: a `settings.json.tmp.<pid>.<hash>` left in the
throwaway config dir by the atomic write, in a run killed mid-flight.

## Measured — the keys, and two of them matter more than the rest (ADR-0017)

The list includes:

```
model=default|sonnet|opus|haiku|best|sonnet[1m]|opusplan
workflows=true|false
workflowSizeGuideline=unrestricted|small|medium|large
permissionMode=default|plan|acceptEdits|auto|dontAsk
```

## What this does not settle

**Not verified — what `/clear` costs today.** ADR-0013's claim that it is billed
as prose is ADR-0012's mechanism applied to one more string, not a fresh
measurement. That ADR verified the mechanism directly — `attribution.ts` writes
the Caller Marker first, so the frame does not begin with a slash, so Claude Code
sees prose — and measured one instance of it at `num_turns: 1` and
`total_cost_usd: 0.0549`. `/clear` takes the same path for the same reason. The
figure is that measurement's, quoted for scale rather than re-measured.

**Not measured — whether a relayed `/config model=…` actually moves a running
Session's model.** ADR-0017's decision does not turn on it: what disqualifies
relaying is that the write is deployment-wide and persistent, which was observed,
and that is enough.
