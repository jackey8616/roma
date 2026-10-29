# 31. A guardrail is a test not yet written

Date: 2026-10-29

## Status

Accepted, and **implemented** on the branch that adds this file. Five guardrails
are checks, the comment whitelist and the ADR citation check run in CI, and a
pre-commit hook and a Claude Code hook hold the gate. The rest of the inventory
below is not converted; this ADR records what was, and the rule for the rest.

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
- 59 guardrails that could fail have no check yet. They are listed in the
  inventory, `docs/guardrail-inventory.md`, with their origin and suggested rung.
  Converting one deletes its prose and shrinks the suppressions file.
- The pre-commit hook needs Node 22, which `.nvmrc` already asks for. Under an
  older `node`, ESLint refuses to run and the commit fails loudly, not quietly.
