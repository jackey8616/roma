# 32. roma has no comments, only tool directives

Date: 2026-10-31

## Status

Accepted, and **implemented**. Supersedes ADR-0031's *Comments in `src/` are a
whitelist* and its exemption for JSDoc on a reachable symbol. The rest of
ADR-0031 stands: a guardrail is still a test, and an ADR Decision a check holds
still says *Enforced by*.

## Context

ADR-0031 limited which **kinds** of comment `src/` may hold, and left two doors
open: JSDoc on anything a caller can reach, and every file outside `src/` or in
a test. Behind both, 7240 comments were still in the tree, 1821 of them recorded
as violations in `eslint-suppressions.json` and the rest allowed.

Every change to roma is now written by an agent, and an agent extends the code it
reads. A comment it reads is a pattern it copies: it writes more comments in the
same voice, and keeps restating what the old ones claimed after the code has
moved on. A suppression file keeps an old comment from failing lint; it does not
keep it out of the agent's context. So the allowed comments, and the suppressed
ones, were the source of the comments the rule then had to refuse.

The code is the context an agent needs. What it cannot say is held elsewhere:
what would break, by a test titled `[fence:<id>]`; why, by `docs/adr/`; what a
word means, by `CONTEXT.md`.

## Decision

### A comment is a tool directive, or it is not written

Enforced by `roma/comment-whitelist`, over every `.ts`, `.mts`, `.cts`, `.js`,
`.mjs` and `.cjs` file in the repository except vendored skills, worktrees,
fixtures and build output. A comment is one of:

- `eslint-disable`, `eslint-disable-next-line`, `eslint-disable-line`,
  `eslint-enable`, or `@ts-expect-error`, with its reason after ` -- `;
- a `/// <reference>` line;
- a `#!` line.

Nothing else: no JSDoc, no `SAFETY:`, no `Enforced by` citation, no
`@ts-ignore`. A tool that needs another directive is added to the rule, with a
case in its test.

### A directive's reason is one name a check resolves

The reason is `fence:<id>`, `roma/<rule>` or `ADR-NNNN`, and the rule fails when
the name resolves to nothing. Free text there would be a comment that rots; a name
fails lint the day what it names is gone.

### An agent hears about a comment in the turn it writes one

Enforced by `fence:no-comments-hook`: a Claude Code `PostToolUse` hook lints
every file an agent writes or edits and hands the agent the failures, with
ADR-0032 named. Lint in the pre-commit hook and in CI stays the gate that counts.

### Nothing is grandfathered

The 7240 comments were deleted, not suppressed, and `eslint-suppressions.json` is
gone. A fixer on the rule did it, and the deletion was checked to change no
code: every one of the 187 files it touched prints the same TypeScript AST with
comments stripped as it did on `main`. Two files held a version only in a comment
that `fence:pin-lists-name-the-version` reads; they now export it as
`JUDGED_AGAINST_CLAUDE_CODE`.

## Consequences

- **What the deleted comments said is in git history and nowhere else**, unless
  an ADR, a test or `CONTEXT.md` already said it. ADR-0031's inventory had already
  moved every guardrail it found into a test. *Not enforced (ADR-0031).*
- **The link from code to the check that holds it is now one-way.** A test
  title names its fence and an ADR cites it; the code no longer points back.
- **Empty `catch {}` blocks no longer say why they swallow.** A reader who
  thinks one is a bug should find the test that holds it, or write one.
- The hook needs the Node `.nvmrc` names. Under another one it tells the agent
  the check did not run rather than passing silently.
- A person can still write a comment in a terminal. The pre-commit hook and CI
  refuse it.
