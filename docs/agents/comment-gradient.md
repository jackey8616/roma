# Comment Gradient

How much prose a symbol in `src/` gets, and why the amount is a signal rather than a style.

An **interface** is everything a caller must know to use a module correctly — the type, the
invariants, the ordering constraints, the failure modes. In roma almost all of that is written
in JSDoc, so the size of a comment *is* the width of the interface. Thick prose on something a
caller can reach is the interface doing its job. Thick prose on something a caller cannot reach
has no reader.

## The gradient

**Reachable — an export, an interface member, a public method.** Write what a caller must know.
No limit; this is the interface.

**Unreachable — a non-exported symbol, a `#private` member.** One line, matching the 62 that
already read this way:

```ts
/** A Task waiting for the Shared Window to come back. */
/** Money as people read it, which is two decimal places and no more. */
/** base64url, which is base64 with two characters swapped and the padding gone. */
```

The line is drawn at **reachability, not at `export`**. A `#private` method is as unreachable as
a module-level function, and one that happens to live inside a class is not owed more prose for
it.

## The exception: the guardrail test

An unreachable symbol earns more than a line only when its comment is a **guardrail**, which
means both halves:

1. a change a reader would plausibly make, and
2. the concrete thing that would then break.

Keep the breakage. Drop the argument around it.

```ts
// Guardrail — the change is obvious, the breakage is nameable.
/**
 * Not `table[spelling]`: an object literal inherits `Object.prototype`, so
 * `COMMANDS['constructor']` answers with a function, and the single word
 * `constructor` was swallowed as a Command that does not exist.
 */

// Not a guardrail — nothing breaks if it goes.
/**
 * Named for the queue's own verb rather than for roma's, because it is the
 * queue's word — roma's is settling, and an Acknowledgement is something else.
 */
```

If the honest answer is *"it would be less clear"* or *"the name came from…"*, it is not a
guardrail. Delete it.

Phrase a surviving guardrail as the rule it enforces — **"Never `X`: …"**, **"Not `X`: …"**,
**"Do not delete this: …"** — so a reader meets the prohibition before the reasoning.

## What goes where instead

- **What a term means** → `CONTEXT.md`. Cite it; never restate it.
- **Why a decision was taken** → `docs/adr/`. Cite the ADR; never re-argue it.
- **What a measurement showed** → the seam 2 test that asserts it. A number in prose goes stale
  silently; a number in an assertion fails.
- **What used to be true before an amendment** → the commit. That is what git is.

A citation is one clause. `(ADR-0018)` is enough — if the reader needs the argument, the ADR is
where the argument lives, and it is the version that gets amended.

## Scope

`src/` only. Tests are deliberately not covered yet: a comment above a test is often the thing
that stops the test being deleted, which is a different risk from the one this rule addresses,
and it has not been calibrated.
