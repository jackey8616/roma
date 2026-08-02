# Verification: what the pinned build does with a relayed slash command

Date: 2026-07-30
Status: **run.** Both halves of ADR-0012 were measured — the fault it exists to
fix, and the invocation shape that fixes it — along with the four commands on the
list and what happens when an entry is gone.

Measured on: the pinned build (2.1.220, ADR-0007), in this repo's container.

Extracted from ADR-0012's `Verification status` on 2026-08-02. The measurements
and their prose are unchanged; what moved is where they live. ADR-0012 keeps the
findings that bear on its decision — and everything it verified about roma's own
code — and links here for the evidence, in the shape ADR-0011 uses.

## Verified — the fault

`<from>Ada (users/17)</from>\n\n/context` drives a real Turn: `num_turns: 1`,
`total_cost_usd: 0.0549`, and the result is the model's prose *about* `/context`
rather than the command's output. Reproduced independently through Google Chat
against a running roma, which is where it was first seen.

## Verified — the fix, on roma's own invocation

`/context\n\n<from>…</from>`, written as a `{type:'user'}` frame to the stdin of
a process spawned with `--input-format stream-json --output-format stream-json
--verbose --include-partial-messages --replay-user-messages --session-id`,
returns `num_turns: 0`, `total_cost_usd: 0`, and the command's real output. The
marker survives into the Transcript, as
`<command-args><from>…</from></command-args>` beside
`<command-name>/context</command-name>`.

## Verified — the list

`/context`, `/usage`, `/cost` and `/stats` each return `num_turns: 0` and
`total_cost_usd: 0`. `/cost` and `/stats` are aliases Claude Code declares on
`/usage` and they resolve to it.

## Verified — that the list fails safely when an entry is gone

`/skill-doctor` — which the binary carries with `supportsNonInteractive:!0` but
this build does not register — returns `Unknown command: /skill-doctor`, at
`num_turns: 0` and `total_cost_usd: 0`. A missing entry does not fall back to
being a prompt.

## Verified — that a resumed process reports the Session, not the process

A Turn whose `result.usage` summed to 35,225 input-side tokens was followed by
`--resume` and `/context` on a new process, which reported `35.2k / 967k` with
`Messages` at `4.6k` — against `8` on a process with no history. Resume
rehydrates, and the two independent readings agree.

## What this does not settle

**Not verified — `--permission-mode bypassPermissions`.** The stdin replication
above omits it: the flag is refused to root and the container this was measured
in runs as root, where roma's does not. It has nothing to do with how a message
is parsed, but it is a difference between what was run and what roma runs, and
naming it is cheaper than someone later discovering it.

**Not verified — any build but this one.** Every measurement here is a fact about
2.1.220. That is the whole reason ADR-0012's list is a list rather than a rule.
