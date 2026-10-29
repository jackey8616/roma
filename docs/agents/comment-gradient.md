# Comment Gradient

How much prose a symbol in `src/` gets, and where a guardrail goes instead of a
comment. ADR-0031 is the decision; this is how to apply it.

## A guardrail is a test not yet written

A **guardrail** names two things: a change a reader would plausibly make, and the
concrete thing that would then break. That is the specification of a check, so a
guardrail is written as a check. It does not get a comment.

1. **Pick the highest rung that can stop the change:** structure or type > lint >
   test > `scripts/check-*.ts`. Make the bad change impossible to write if you can.
   Make it fail a check if you cannot.
2. **Show it red before it counts.** Re-plant the bug, or check out the fix's
   parent, and watch the check fail. Then watch it pass on main with nothing
   else red.
3. **Write a failure message that explains itself.** Say what was violated, why
   it matters, and which ADR decided it. The reasoning lives in the message,
   where it is read at the moment it is needed.
4. **Name it.** For a test, put `[fence:<id>]` in its title. For a lint rule, the
   name is `roma/<rule>`.
5. **Leave one line where the prose was:** `Enforced by` and the name in
   backticks. Delete the rest of the prose.

```ts
// Before: prose that a refactor could make untrue without anything noticing.
/**
 * Not `table[spelling]`: an object literal inherits `Object.prototype`, so
 * `COMMANDS['constructor']` answers with a function, and the single word
 * `constructor` was swallowed as a Command that does not exist.
 */

// After: the tables are ReadonlyMaps, so the bad lookup does not compile
// (TS7052), and a test titled [fence:table-lookup-ignores-the-prototype]
// holds it at runtime. Nothing is left to comment.
```

If a check and the prose disagree, **the check wins**. Correct the prose, or
delete it.

A guardrail that names no breakage a check could see (a cost, a permission, a
rejected option) is not a comment either. It belongs in the ADR that decided it,
marked *Not enforced (ADR-0031).*

## What a comment in `src/` may be

Enforced by `roma/comment-whitelist`, in `src/` outside its tests:

- a suppression with its reason: `// eslint-disable-next-line rule -- why`,
  `// @ts-expect-error -- why`;
- a `SAFETY:` comment;
- one line that cites a check by name.

Comments that predate the rule are in `eslint-suppressions.json`. When you delete
one, run `npx eslint src --prune-suppressions`. Lint fails on a suppression
nothing needs any more, so the file only shrinks. Never add to it by hand.

## JSDoc on what a caller can reach

An **interface** is everything a caller must know to use a module correctly. JSDoc
on a reachable symbol is out of scope for the whitelist (ADR-0031). A reachable
symbol is an export, or a non-private member of one. The gradient below still
governs this JSDoc:

- **Write what a caller must know**: the invariants, ordering constraints and
  failure modes the type cannot express.
- **A guardrail is still a check.** If the JSDoc names a change and what breaks,
  that part goes through the five steps above.
- **Do not argue a decision.** The reason for it belongs in `docs/adr/`.

## What goes where instead

- **What a term means** goes in `CONTEXT.md`. Cite it; never restate it.
- **Why a decision was taken** goes in `docs/adr/`. Cite the ADR; never re-argue
  it. An ADR Decision that a check holds is marked *Enforced by* and the check's
  name, which `scripts/check-adr-enforcers.ts` keeps true.
- **What a measurement showed** goes in the seam 2 test that asserts it.
- **What used to be true before an amendment** is in the commit.

## Scope

`src/`, outside its tests. Tests are not covered: a comment above a test is often
the thing that stops the test being deleted, which is a different risk.
