# 31. A guardrail is a test not yet written

Date: 2026-10-29

## Status

Accepted, and **implemented**. Five guardrails were converted with this ADR; a
sweep that followed converted the rest of the inventory (see *Amended — the
sweep*). The comment whitelist and the ADR citation check run in CI, CI is
required on `main` by a repository ruleset, and a pre-commit hook and a Claude
Code hook hold the gate.

**Superseded in part by ADR-0032** (2026-10-31). *Comments in `src/` are a
whitelist*, its JSDoc exemption and `eslint-suppressions.json` are replaced: roma
now has no comments but tool directives, anywhere, and none are grandfathered.
The `Enforced by` line in code is gone with them. The rest of this ADR stands.

## Context

`docs/agents/comment-gradient.md` defined a **guardrail** as a comment with two
halves: a change a reader would plausibly make, and the concrete thing that would
then break. That is the specification of a test. It let the guardrail stay prose.

Prose fails silently. ADR-0002's *Quota exhaustion* amendment went on describing
the rule #83 had reversed, and nothing noticed; the test written for #83 was
right the whole time.

An inventory on 2026-10-29 (ts-morph over `src/`, the workflows and `docs/adr/`,
each statement traced with `git log -S`) found 432 guardrails. 403 name a
breakage a check could hold; 344 of those already had a test that would fail.
The other 29 are judgements about cost, permissions or rejected options, where
nothing in the code breaks. So for most guardrails, the prose was restating a
test, and the copy that drifts is the prose.

The method is Lauren Tan's *Dune* (ratstack.sh, *The Fence* and *No Comments*):
a fix climbs to the highest rung of the trust ladder that can stop it, and where
a check and the prose disagree, the check wins.

## Decision

### A guardrail that can fail is written as a check, on the highest rung that holds it

The ladder, highest first: **structure or type > lint > test > `scripts/check-*.ts`**.
A check is shown to fail before it counts: red against the bug re-planted, or at
the fix's parent, and green on main. Its failure message says what was violated,
why, and which ADR.

A check is named so prose can cite it: a test whose title carries
`[fence:<id>]`, or a rule `roma/<rule>`. A citation is one line, *Enforced by*
and the name in backticks, and the prose it replaces is deleted.

The first five, each with its evidence in the PR that adds this file:
`fence:refusal-keeps-both-halves` (#107), `fence:volume-paths-owned-by-node`
(#54), `fence:only-rejected-is-spent` (#83), `fence:answered-by-the-last-attempt`
(#56), and `fence:table-lookup-ignores-the-prototype` (#120), which climbed to the
type rung: the Command and Relay tables are `ReadonlyMap`s, so the lookup that
swallowed `constructor` no longer compiles.

### A guardrail that cannot fail stays in an ADR, marked as not enforced

Cost, permissions and rejected options name no breakage a check could see. They
stay in the ADR that decided them, marked *Not enforced (ADR-0031).* The marker
says plainly that nothing holds the line, so nobody reads one as a guarantee.

### An ADR Decision a check holds says which

A Decision a check now holds is marked *Enforced by* and the check's name.
Enforced by `fence:adr-enforcers-exist`: `scripts/check-adr-enforcers.ts` fails
when a cited name resolves to nothing, so a renamed test cannot leave an ADR
claiming enforcement that nothing performs.

### Comments in `src/` are a whitelist

Enforced by `roma/comment-whitelist`, in `src/` outside its tests. A comment is
one of:

- a suppression directive with its reason after ` -- `;
- a `SAFETY:` comment;
- one line citing a check that exists.

**JSDoc on a reachable symbol is out of scope**, by the user's decision on
2026-10-29. The inventory measured it: 795 comments and 7214 lines, of which
about 690 lines (9.5%, spread across 347 comments) are invariants the type
cannot express. The rest is mostly rationale that belongs in an ADR, and
definitions that belong in `CONTEXT.md`. Those comments stay under
`comment-gradient.md` until a later decision covers them.

The 1821 comments that broke the rule when it landed are recorded in
`eslint-suppressions.json`. A suppression that nothing needs any more fails
lint, so the file can only shrink.

### The gate is held, not trusted

The pre-commit hook runs the lint and the ADR check. Enforced by
`fence:no-verify-is-refused`: a Claude Code `PreToolUse` hook refuses
`--no-verify`, `git commit -n`, and a `core.hooksPath` override. Enforced by
`fence:ci-runs-the-fences`: CI runs both checks in the existing `checks` job,
under its existing name.

## Consequences

- **A person can still skip the hook.** `git commit --no-verify` from a terminal
  is not refused; the Claude Code hook only governs an agent. CI is the backstop,
  and CI is the gate that counts. *Not enforced (ADR-0031).*
- **CI is required, by a repository setting.** The ruleset "main: CI must pass,
  squash only" requires the `checks` job and the ADR-number job. A repository
  administrator may still push to `main` directly, as a release does.
  *Not enforced (ADR-0031).* That both job names still exist is held:
  Enforced by `fence:required-check-names`.
- A citation may name several checks (`Enforced by` and names joined by commas
  or `and`), and every name in it must resolve. Enforced by
  `fence:every-cited-name-resolves`.
- The pre-commit hook needs the Node `.nvmrc` names. Under another one it stops
  before ESLint and says which Node to use, so the error does not point a person
  at `--no-verify`. Enforced by `fence:hook-names-the-node-it-needs`.
- A fence name picks out one check: two test files carrying the same
  `[fence:<id>]` fail the ADR check. Enforced by `fence:one-name-one-fence`.

## Amended — the sweep

The rest of the inventory was converted the same way, one slice of `src/` at a
time, then the ADRs. Every check was shown red against the change re-planted
before it was cited. Afterwards: 325 fences, 348 citations in `src/` and 79 in
`docs/adr/`, 1373 suppressed comments where there were 1821, and 1533 tests
where there were 1406.

**About one claim in ten in the inventory was wrong.** A test it said held a
guardrail passed with the bug re-planted, usually because the fixture never
reached the case. Each of those got a new test or a stronger assertion, so a
guardrail now counts as held only when its fence has been seen to fail.

What the sweep left, and what became of it:

- Unbuilt Decisions: ADR-0008's Requested-by trailer and ADR-0025's Runtime offer.
  *Not enforced (ADR-0031): not built.*
- `new GoogleAuth()` in the composition root used to pass every test. It is now
  held by an allowlist (ADR-0020 §7, amended). Enforced by
  `fence:chain-only-for-romas-own-identity`.
- ADR-0007's drift check was held only for its parsing. Its I/O half (reading the
  Dockerfile, the registry and `grep`) now takes its I/O as a parameter so the free
  run can fail it. Enforced by `fence:drift-io-fails-loud`.
- ADR-0011 said a Task stopped while queued never fetches its Enclosures. It
  does, because Enclosures are written before the Task is queued. ADR-0011 is
  amended to say so, and to cite the fences that hold what late fetching does
  avoid.