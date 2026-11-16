const EXACT_VERSION = /^\d+\.\d+\.\d+$/

export type PinName = 'claude-code' | 'codex'

export interface Pin {
  readonly name: PinName
  readonly runtime: string
  readonly arg: string
  readonly npmPackage: string
  readonly adr: string
  readonly evidenceInDocs: string
  readonly liveTests: string
  readonly liveTestsDrive: string
  readonly sharedWindow: string
}

const ALL: readonly Pin[] = [
  {
    name: 'claude-code',
    runtime: 'Claude Code',
    arg: 'CLAUDE_CODE_VERSION',
    npmPackage: '@anthropic-ai/claude-code',
    adr: 'ADR-0007',
    evidenceInDocs: 'every measurement in `docs/`',
    liveTests: 'seam 2',
    liveTestsDrive: 'a real `claude -p`',
    sharedWindow: "Claude Code's **Shared Window**, not Codex's",
  },
  {
    name: 'codex',
    runtime: 'Codex',
    arg: 'CODEX_VERSION',
    npmPackage: '@openai/codex',
    adr: 'ADR-0026 *The pins*',
    evidenceInDocs: 'every Codex reading in `docs/`',
    liveTests: 'the Codex live tests',
    liveTestsDrive: 'a real `codex app-server`',
    sharedWindow: "Codex's **Shared Window**, not Claude Code's",
  },
]

export const PINS: ReadonlyMap<string, Pin> = new Map(ALL.map((pin) => [pin.name, pin]))

export interface Drift {
  pinned: string
  published: string
  evidence: string[]
}

export interface DriftReport {
  title: string
  body: string
}

export function pinNamed(name: string | undefined): Pin {
  const pin = name === undefined ? undefined : PINS.get(name)

  if (pin === undefined) {
    throw new Error(
      `no pin is named ${JSON.stringify(name)}; the pins are ${[...PINS.keys()].join(', ')}`,
    )
  }

  return pin
}

export function pinnedVersion(pin: Pin, dockerfile: string): string {
  const assignment = new RegExp(`^ARG ${pin.arg}=(.*)$`, 'gm')
  const assigned = [...dockerfile.matchAll(assignment)].map(([, value]) => value ?? '')

  if (assigned.length === 0) {
    throw new Error(`the Dockerfile assigns no ARG ${pin.arg}`)
  }

  if (assigned.length > 1) {
    throw new Error(`the Dockerfile assigns ARG ${pin.arg} twice: ${assigned.join(', ')}`)
  }

  const [pinned = ''] = assigned

  if (!EXACT_VERSION.test(pinned)) {
    throw new Error(`ARG ${pin.arg} is not an exact version: '${pinned}'`)
  }

  return pinned
}

export function publishedVersion(pin: Pin, document: unknown): string {
  const version =
    typeof document === 'object' && document !== null && 'version' in document
      ? (document as { version: unknown }).version
      : undefined

  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    throw new Error(
      `the registry named no exact version of ${pin.npmPackage}: ${JSON.stringify(document)}`,
    )
  }

  return version
}

export function labelFor(pin: Pin): { label: string; description: string } {
  return {
    label: `${pin.name}-drift`,
    description: `The pinned ${pin.runtime} has fallen behind the published one (notify-only)`,
  }
}

export function driftReport(pin: Pin, { pinned, published, evidence }: Drift): DriftReport {
  if (evidence.length === 0) {
    throw new Error(`refusing a report with no evidence: no file names ${pinned}`)
  }

  const body = `\`Dockerfile\` pins ${pin.runtime} at **${pinned}**. The \`latest\` dist-tag of
\`${pin.npmPackage}\` is **${published}**.

That is the whole of what this check knows. It has not read the changelog, it has
no opinion about whether ${published} is better, and it is not asking for the pin
to be moved. **Nothing is broken** — the pinned version working correctly is the
normal state, so this is not an incident and not a bug report.

## What moving the pin would cost

${pin.adr} makes this pin a re-verification event rather than a dependency bump:
${pin.evidenceInDocs} is evidence about ${pinned} and no other version.
So moving it means re-running **${pin.liveTests}** — the tests that drive ${pin.liveTestsDrive} —
and those spend real money on ${pin.sharedWindow}.
\`CLAUDE.md\` says how to run them, and a human reading the behavioural diff
afterwards is the part that cannot be automated.

No workflow in this repository can do it: none of them is handed either Runtime's
credential, and \`src/packaging.test.ts\` goes red if one ever is.

## What currently rests on ${pinned}

${evidence.map((file) => `- \`${file}\``).join('\n')}

Generated with \`grep -F\` at the commit this ran against, so it is the working
tree's own answer rather than a list somebody maintains. It is also the size of the
re-verification: every one of those files is a claim about ${pinned} that moving the
pin makes unproven until it is re-verified against the new build.

## What to do with this

- **Decline it** — close this issue. Declining is a normal outcome, and this check
  expects to be declined more often than acted on. It has no memory: while ${published}
  is what npm publishes, the next run will report it again, and the cadence is the
  thing to change if that becomes tedious.
- **Move the pin** — a human edits \`Dockerfile\` and \`src/packaging.test.ts\`
  together, runs ${pin.liveTests}, and reads what changed.
  ${pin.adr} is what that means.

Either way, not this check. It never edits the pin and it opens no pull request:
a green CI run on a diff that moved the pin would launder an unverified claim into
an approved one, because CI runs no live test.

---

Reported by \`.github/workflows/${pin.name}-drift.yml\`, which reads the pin out of the
\`Dockerfile\` rather than carrying its own copy.
`

  return { title: `${pin.runtime} ${published} is published; the image pins ${pinned}`, body }
}
