/**
 * The drift check's judgement, with none of its I/O.
 *
 * `.github/workflows/claude-code-drift.yml` asks one question weekly: is the
 * Claude Code the image pins still the one npm publishes? Everything that decides
 * *what the answer means* is here — reading the pin, reading the registry, and
 * wording the report — because all three fail the same way, quietly. A
 * reformatted `ARG` line, a registry document that changed shape, a report that
 * lost the sentence about what moving the pin costs: none of those announce
 * themselves at runtime. They produce a check that passes forever while watching
 * nothing, and a green tick reads as "the pin is current".
 *
 * So every function here throws rather than degrades, and `scripts/claude-code-drift.test.ts`
 * asserts each refusal in the free run. What the entry point is left with is
 * genuinely only I/O.
 *
 * This module reports. It does not bump: nothing here writes a file, and nothing
 * downstream of it opens a pull request. `.github/dependabot.yml` and ADR-0007
 * carry the reason — a bump PR would look like routine maintenance while
 * invalidating every measurement in `docs/`, and CI would go green, because
 * seam 2 does not run there.
 */

/**
 * A version this check can compare, which is a narrower thing than a version
 * specifier.
 *
 * Exact only: `latest`, `^2.1.220` and `${UPSTREAM}` all resolve to something
 * else on a day nobody is looking, so comparing one against the registry compares
 * a string rather than a pin. ADR-0007 requires the pin to be exact for the same
 * reason, and `src/packaging.test.ts` already fails if it stops being — this is
 * that requirement arriving a second time, at the only other place the number is
 * read.
 *
 * Three components and nothing else, so a prerelease is refused rather than
 * accommodated. No Claude Code this repository has pinned has ever been one, and a
 * registry that starts publishing them under `latest` is a thing somebody should
 * be told about out loud rather than something this quietly copes with.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/

/** Every line that assigns the `ARG`, so that two of them can be refused. */
const PIN = /^ARG CLAUDE_CODE_VERSION=(.*)$/gm

/** What the report needs to know, and the whole of it. */
export interface Drift {
  /** The version `Dockerfile` pins. */
  pinned: string
  /** The version npm publishes under the `latest` dist-tag. */
  published: string
  /**
   * Every file in the working tree that names the pinned version — generated,
   * never maintained. This is the size of the re-verification.
   */
  evidence: string[]
}

/** The issue the workflow files, or edits into. */
export interface DriftReport {
  title: string
  body: string
}

/**
 * The pinned version, from the Dockerfile's own `ARG`.
 *
 * Read rather than restated, because a drift check that carried a third copy of
 * the number would be one more thing to remember to edit — and the version of
 * this check that has drifted is worth less than no check at all. `Dockerfile`
 * and `src/packaging.test.ts` already hold the two copies ADR-0007 asks for; this
 * makes no third.
 *
 * Anchored at the start of a line with no allowance for leading whitespace or a
 * `#`, so the Dockerfile's commentary — which names versions more than once — is
 * not mistaken for an instruction.
 *
 * @throws if no line assigns the `ARG`, if more than one does — which copy this
 * check watched would then be decided silently — or if what it assigns is not an
 * exact version, because a pin that resolves to something else later cannot be
 * compared against the registry at all.
 */
export function pinnedClaudeCode(dockerfile: string): string {
  const assigned = [...dockerfile.matchAll(PIN)].map(([, value]) => value ?? '')

  if (assigned.length === 0) {
    throw new Error('the Dockerfile assigns no ARG CLAUDE_CODE_VERSION')
  }

  if (assigned.length > 1) {
    throw new Error(`the Dockerfile assigns ARG CLAUDE_CODE_VERSION twice: ${assigned.join(', ')}`)
  }

  const [pinned = ''] = assigned

  if (!EXACT_VERSION.test(pinned)) {
    throw new Error(`ARG CLAUDE_CODE_VERSION is not an exact version: '${pinned}'`)
  }

  return pinned
}

/**
 * The published version, from `registry.npmjs.org`'s `latest` dist-tag document.
 *
 * Validated rather than trusted. The document is fetched over the network from a
 * service that answers with JSON on failure too, and an `undefined` compared
 * against the pin is a difference — so an unparseable answer that ends the run
 * red is the only safe reading of one.
 *
 * @throws if the document is not an object carrying an exact version string.
 */
export function publishedClaudeCode(document: unknown): string {
  const version =
    typeof document === 'object' && document !== null && 'version' in document
      ? (document as { version: unknown }).version
      : undefined

  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    throw new Error(`the registry named no exact version: ${JSON.stringify(document)}`)
  }

  return version
}

/**
 * The report a human reads, which is the whole deliverable of this check.
 *
 * "2.1.221 is out" would invite exactly the reflex the pin exists to stop, so the
 * cost is stated in the same breath as the availability: what re-verification is,
 * whose money it spends, and how many files currently rest on the pinned version.
 * The reader is choosing, not tidying.
 *
 * @throws if there is no evidence to list. Zero files means the `grep` and the
 * `ARG` disagree about what the pinned version is, and a report with an empty
 * evidence section reads as "moving the pin costs nothing".
 */
export function driftReport({ pinned, published, evidence }: Drift): DriftReport {
  if (evidence.length === 0) {
    throw new Error(`refusing a report with no evidence: no file names ${pinned}`)
  }

  const body = `\`Dockerfile\` pins Claude Code at **${pinned}**. The \`latest\` dist-tag of
\`@anthropic-ai/claude-code\` is **${published}**.

That is the whole of what this check knows. It has not read the changelog, it has
no opinion about whether ${published} is better, and it is not asking for the pin
to be moved. **Nothing is broken** — the pinned version working correctly is the
normal state, so this is not an incident and not a bug report.

## What moving the pin would cost

ADR-0007 makes this pin a re-verification event rather than a dependency bump:
every measurement in \`docs/\` is evidence about ${pinned} and no other version. So
moving it means re-running **seam 2** — the tests that drive a real \`claude -p\` —
and those spend real money on the **Shared Window** everybody shares.
\`CLAUDE.md\` says how to run them, and a human reading the behavioural diff
afterwards is the part that cannot be automated.

No workflow in this repository can do it: none of them is given a Shared Window
token, and \`src/packaging.test.ts\` goes red if one ever is.

## What currently rests on ${pinned}

${evidence.map((file) => `- \`${file}\``).join('\n')}

Generated with \`grep -F\` at the commit this ran against, so it is the working
tree's own answer rather than a list somebody maintains. It is also the size of the
re-verification: every one of those files is a claim about ${pinned} that moving the
pin makes unproven until seam 2 has been run again.

## What to do with this

- **Decline it** — close this issue. Declining is a normal outcome, and this check
  expects to be declined more often than acted on. It has no memory: while ${published}
  is what npm publishes, the next run will report it again, and the cadence is the
  thing to change if that becomes tedious.
- **Move the pin** — a human edits \`Dockerfile\` and \`src/packaging.test.ts\`
  together, runs seam 2, and reads what changed. ADR-0007 is what that means.

Either way, not this check. It never edits the pin and it opens no pull request:
a green CI run on a diff that moved the pin would launder an unverified claim into
an approved one, because seam 2 does not run in CI.

---

Reported by \`.github/workflows/claude-code-drift.yml\`, which reads the pin out of
the \`Dockerfile\` rather than carrying its own copy.
`

  return { title: `Claude Code ${published} is published; the image pins ${pinned}`, body }
}
