# Comment Gradient

There is no gradient any more: roma has no comments, only tool directives.
ADR-0032 is the decision; this is how to apply it.

## What a comment may be

Enforced by `roma/comment-whitelist`, in every TS and JS file except vendored
skills, worktrees, fixtures and build output:

- `// eslint-disable-next-line rule -- <name>` (and `-disable`, `-disable-line`,
  `-enable`);
- `// @ts-expect-error -- <name>`;
- `/// <reference …>`;
- a `#!` line.

`<name>` is one of `fence:<id>`, `roma/<rule>` or `ADR-NNNN`, and it must resolve.
Nothing else is allowed: no JSDoc, no `SAFETY:`, no `Enforced by` line.

An agent hears about a comment as soon as it writes one: the `PostToolUse` hook in
`.claude/settings.json` lints the file and fails. `npx eslint --fix <file>`
deletes prose comments. It never deletes a directive.

## Where what you wanted to say goes instead

- **A change and what it would break** is a test titled `[fence:<id>]`, on the
  highest rung that can hold it: structure or type > lint > test >
  `scripts/check-*.ts`. Show it red against the bug re-planted, then green. Its
  failure message says what was violated, why, and which ADR (ADR-0031).
- **Why a decision was taken** goes in `docs/adr/`. An ADR Decision a check
  holds is marked *Enforced by* and the check's name, which
  `scripts/check-adr-enforcers.ts` keeps true.
- **What a term means** goes in `CONTEXT.md`.
- **What a caller must know** is the name and the type. If the type cannot say
  it, make it say it, or write the test that fails when a caller gets it wrong.
- **What a measurement showed** goes in the seam 2 test that asserts it.
- **What used to be true** is in the commit.

Do not move the text into a string, a directive's reason or an identifier to get
it past the rule.
