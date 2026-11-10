const EXACT_VERSION = /^\d+\.\d+\.\d+$/

const PIN = /^ARG CLAUDE_CODE_VERSION=(.*)$/gm

export interface Drift {
  pinned: string
  published: string
  evidence: string[]
}

export interface DriftReport {
  title: string
  body: string
}

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
