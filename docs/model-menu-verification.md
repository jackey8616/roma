# Verification: what the pinned build does with `--model` and `/model`

Date: 2026-07-31
Status: **run.** ADR-0014 was written entirely off `grep` against the pinned
build's bundle. `src/model-menu.live.test.ts` has since been run against a real
`claude -p` on that build, which turns most of what follows from a reading into a
measurement. Each item below says which it is, and the two that disagreed say so.

Measured on: the pinned build (2.1.220, ADR-0007).

Extracted from ADR-0014's `Verification status` on 2026-08-02. The measurements
and their prose are unchanged; what moved is where they live. ADR-0014 keeps the
claims that bear on its decision and links here for the evidence, in the shape
ADR-0011 uses.

## Measured — the id roma sends is accepted and echoed

`--model claude-opus-5`, `--model claude-sonnet-5` and `--model claude-haiku-4-5`
each start and report themselves back as `system/init.model`. This is the one the
design rests on: `--model` receives the id, the Audit Record and the Operator Log
file the id, and this is the evidence that what roma writes down is what ran.

## Measured, and it corrected the reading — the first-party alias table

Read out of the bundle as

```
{fable:"claude-fable-5", opus:"claude-opus-5",
 sonnet:"claude-sonnet-5", haiku:"claude-haiku-4-5"}
```

and the live build expands `opus` and `sonnet` to exactly that, but `haiku` to
`claude-haiku-4-5-20251001` — a **dated snapshot**, where the other two are
undated ids. The Menu is unaffected and was not changed: it holds undated ids
uniformly, roma sends the id rather than the alias, and `--model claude-haiku-4-5`
is accepted and echoed undated. What was wrong was the first seam 2 check, which
spawned on the alias and demanded the id back — one spawn asked to carry both an
assertion about roma and a recording of a table roma does not control, and it went
red without either being at fault. It now measures the two separately.

`PINNED_MODEL` is `claude-sonnet-5`, which is what `sonnet` resolves to. roma
pins the resolved id and a Caller would type the alias, so the two spellings have
to be understood as the same model.

## Measured — `/model` has two descriptors, and the non-interactive one is live

The bundle declares `{type:"local", name:"model", supportsNonInteractive:!0,
argumentHint:"<model>", isEnabled:()=>yn()}` and a second `{type:"local-jsx",
name:"model", …}`; the first takes an argument non-interactively, the second is a
picker a Channel could not show, and which wins depends on `yn()`. Relayed to a
real `claude -p`, the first is what answers:

```
/model      → "Current model: Sonnet 5
               Usage: /model <name>. Available: sonnet, opus, haiku, fable, best,
               sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID."
/model opus → "Set model to Opus 5 for this session only"
```

both at `turns=0, cost=0`.

### Amended 2026-07-31 — `yn()` is readable after all, and it is a construction rather than a result

This section said it was not readable statically, and that was a failure to look
rather than a fact. It is:

```js
function _n(){ return !Mt.isInteractive }
```

So under `-p` it is true, and the plain `local` descriptor is the one that answers
— by construction, on any build carrying this definition, rather than on the day
the probe above was run. Found while measuring #98, which needed the same function
for `/autocompact`.

Nothing built changes: roma never relays `/model`, so which descriptor would have
answered is not on roma's path. What it retires is one of the two jobs the seam 2
Menu check was given. It had to prove each Menu entry resolves *and* settle
`yn()`; the second is now free, and the check only has to do the first.

## Measured — what `/model` accepts

The `Available:` line above is the live text, and it ends `or a full model ID`. So
an arbitrary model id is a legal argument upstream, and there is no list roma
could hold that would make validation complete — which is why ADR-0014's decision
is about what roma *offers* rather than about what it can check. It also names
three the Menu does not carry — `fable`, `best` and `opusplan` — which is the Menu
behaving as an offer rather than as a filter, and is worth re-reading when the pin
moves.

## Read — the 1M variants

`{alias:"opus[1m]", name:"Opus 1M", multiplier:5}` and the same for `sonnet`, with
the tip text `` `You have access to ${t.name} with ${t.multiplier}x more context`
``. The multiplier is **context, not price** — stated because the first reading of
that field was the other one, and the mistake is easy to repeat. Still a reading:
the live `Available:` line lists `sonnet[1m]`, `opus[1m]` and `fable[1m]`, which
confirms they exist and says nothing about the multiplier.

## What this does not settle

Nothing here watches a respawn, so it says nothing about whether `--model` and a
relayed `/model` disagree after one. ADR-0014 keeps that caveat, and the reason it
is deliberate rather than pending.
