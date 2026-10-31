export const EFFORT_FLAGS = ['effort', 'xhigh_effort', 'max_effort'] as const

export type EffortFlag = (typeof EFFORT_FLAGS)[number]

export interface FlagGate {
  readonly flag: EffortFlag
  readonly refused: readonly string[]
  readonly allowed: readonly string[]
  readonly source: string
}

export interface MatrixRow {
  readonly model: string
  readonly takes: Readonly<Record<EffortFlag, boolean | null>>
}

const MODEL_ID = /"(claude-[a-z0-9.-]+)"/g

const RETURNS = /return\s*(!0|!1|true|false)\b/g

export function gateFor(bundle: string, flag: EffortFlag): FlagGate {
  const sites = callSites(bundle, flag)

  if (sites.length === 0) {
    throw new Error(`no call passes the feature flag "${flag}" — this build's gate has moved`)
  }

  const bodies = unique(sites.map((site) => enclosingFunction(bundle, site, flag)))
  if (bodies.length > 1) {
    throw new Error(
      `the ${sites.length} calls passing "${flag}" are spread across ${bodies.length} functions; ` +
        `which one is the gate cannot be decided here. Read the bundle.`,
    )
  }

  const [source = ''] = bodies
  return { flag, ...branchesOf(source), source }
}

function callSites(bundle: string, flag: EffortFlag): number[] {
  const call = new RegExp(`,\\s*"${flag}"\\s*\\)`, 'g')
  return [...bundle.matchAll(call)].map((match) => match.index)
}

export function enclosingFunction(bundle: string, index: number, flag: string): string {
  const open = openingBraceBefore(bundle, index)
  if (open === null) {
    throw new Error(
      `the call passing "${flag}" is not inside a block — the bundle's shape has moved`,
    )
  }
  const close = matchingBraceAfter(bundle, open)
  if (close === null) {
    throw new Error(`the block containing "${flag}" never closes — is this a whole file?`)
  }
  const header = bundle.slice(Math.max(0, open - 120), open)
  const from = header.lastIndexOf('function ')
  return (from === -1 ? '' : header.slice(from)) + bundle.slice(open, close + 1)
}

function openingBraceBefore(bundle: string, index: number): number | null {
  let depth = 0
  for (let at = index; at >= 0; at -= 1) {
    const char = bundle[at]
    if (char === '}') depth += 1
    else if (char === '{') {
      if (depth === 0) return at
      depth -= 1
    }
  }
  return null
}

function matchingBraceAfter(bundle: string, open: number): number | null {
  let depth = 0
  for (let at = open; at < bundle.length; at += 1) {
    const char = bundle[at]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return at
    }
  }
  return null
}

function branchesOf(source: string): { refused: string[]; allowed: string[] } {
  const returns = [...source.matchAll(RETURNS)].map((match) => ({
    at: match.index,
    value: match[1] === '!0' || match[1] === 'true',
  }))

  const refused: string[] = []
  const allowed: string[] = []
  for (const match of source.matchAll(MODEL_ID)) {
    const model = match[1]
    if (model === undefined) continue
    const decides = returns.find(({ at }) => at > match.index)
    if (decides === undefined) continue
    ;(decides.value ? allowed : refused).push(model)
  }
  return { refused: unique(refused), allowed: unique(allowed) }
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)]
}

export function effortMatrix(
  bundle: string,
  models: readonly string[],
): { rows: MatrixRow[]; gates: FlagGate[] } {
  const gates = EFFORT_FLAGS.map((flag) => gateFor(bundle, flag))
  const rows = models.map((model) => ({
    model,
    takes: Object.fromEntries(gates.map((gate) => [gate.flag, verdictFor(gate, model)])) as Record<
      EffortFlag,
      boolean | null
    >,
  }))
  return { rows, gates }
}

function verdictFor(gate: FlagGate, model: string): boolean | null {
  if (gate.refused.includes(model)) return false
  if (gate.allowed.includes(model)) return true
  return null
}

export function matrixReport(rows: readonly MatrixRow[], gates: readonly FlagGate[]): string {
  if (rows.length === 0) throw new Error('refusing a report with no models in it')

  const sources = gates
    .map(({ flag, refused, allowed, source }) => sourceOf(flag, refused, allowed, source))
    .join('\n\n')
  const header = `| model | ${EFFORT_FLAGS.join(' | ')} |`
  const rule = `| --- |${EFFORT_FLAGS.map(() => ' --- |').join('')}`
  const body = rows
    .map(
      ({ model, takes }) =>
        `| \`${model}\` | ${EFFORT_FLAGS.map((flag) => said(takes[flag])).join(' | ')} |`,
    )
    .join('\n')

  return `# The Effort Matrix, as read out of the pinned Claude Code

${header}
${rule}
${body}

**\`—\` is not a no.** It means this build's gate does not name the model, so the
answer comes from the server-side feature flag at runtime and nothing here can
see it. Reading one as a refusal is the mistake ADR-0016 records: an earlier
version of this extractor did exactly that and reported a supported model as
unsupported, silently.

Nothing consumes this. \`EFFORT_MATRIX\` in \`src/effort-menu.ts\` is a constant a
person writes after reading the gates below, and the Matrix reports rather than
refuses — roma uses it to say something and to record something, never to turn
away anything a Caller asked for.

## The gates this was read from

${sources}
`
}

function said(verdict: boolean | null): string {
  return verdict === null ? '—' : verdict ? 'yes' : '**no**'
}

function sourceOf(
  flag: string,
  refused: readonly string[],
  allowed: readonly string[],
  source: string,
): string {
  return `### \`"${flag}"\`

Refused by name: ${listed(refused)}
Allowed by name: ${listed(allowed)}

\`\`\`js
${source}
\`\`\``
}

function listed(models: readonly string[]): string {
  return models.length === 0 ? '_none_' : models.map((model) => `\`${model}\``).join(', ')
}
