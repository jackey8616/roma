/**
 * Which models does the pinned Claude Code strip the effort from?
 *
 * The judgement half of the Effort Matrix extractor, with none of its I/O —
 * `scripts/check-claude-code-effort-matrix.ts` finds the bundle and prints. The
 * split is `claude-code-drift.ts`'s and is here for the same reason: everything
 * that decides *what the answer means* fails quietly, so all of it is here where
 * `scripts/claude-code-effort-matrix.test.ts` asserts each refusal in the free
 * run, and the entry point is left with genuinely only I/O.
 *
 * ## It prints. It does not gate.
 *
 * No CI job consumes this, nothing fails on it, and roma refuses nothing because
 * of it. `src/effort-menu.ts` carries the result as a constant, put there by a
 * person who read this output. ADR-0016 records why in the strongest terms it
 * has: the first version written for this opened its window too wide, read into
 * the neighbouring function, and reported `claude-mythos-5` as unsupported when
 * it is on the allowing branch. That failure was silent and would have stayed
 * silent. **An extractor that can do that must print for a human, not decide for
 * a machine.**
 *
 * ## What it anchors on, and why not the obvious thing
 *
 * The server-side feature-flag names — `"effort"`, `"xhigh_effort"`,
 * `"max_effort"` — rather than the minified identifiers around them. Against
 * 2.1.220 the gate reads:
 *
 * ```js
 * function OI(e){ … if(r.includes("claude-3-")||r==="claude-opus-4-0"
 *                     ||r==="claude-sonnet-4-5"||r==="claude-haiku-4-5") return !1
 *                 if(M$(r,"effort")||r==="claude-mythos-5") return !0
 *                 return dj(ny(e)) }
 * ```
 *
 * `OI` and `M$` are renamed every build; `"effort"` is a contract with something
 * on the other side of the network and is not. So the anchor is the flag string,
 * and the function containing it is found by walking outward from there —
 * bounded by brace balance, which is what stops the window from swallowing the
 * neighbour.
 *
 * ## What it cannot see
 *
 * The server-side ceiling. `maxEffortLevel` arrives on the entitled-models
 * response and is nowhere in the bundle, so an account whose plan clamps a level
 * down is invisible to this and to everything else in roma. ADR-0016 names it as
 * the one hole the design leaves open.
 */

/** The feature-flag names the gate is found by, in the order they are reported. */
export const EFFORT_FLAGS = ['effort', 'xhigh_effort', 'max_effort'] as const

export type EffortFlag = (typeof EFFORT_FLAGS)[number]

/** What one flag's gate says about the models named inside it. */
export interface FlagGate {
  readonly flag: EffortFlag
  /**
   * Model ids compared on a branch that returns false — the ones this build
   * refuses the flag to by name.
   */
  readonly refused: readonly string[]
  /**
   * Model ids compared on a branch that returns true — the ones it allows by
   * name, over and above whatever the flag itself says.
   */
  readonly allowed: readonly string[]
  /**
   * The whole function the two lists were read out of.
   *
   * Carried rather than discarded, and printed in full, because this is the only
   * way the reading can be checked. A table with no source under it asks to be
   * believed; this asks to be read.
   */
  readonly source: string
}

/** What one model's row of the Matrix looks like, for a person to read. */
export interface MatrixRow {
  readonly model: string
  /**
   * Three answers rather than two. **Null is "this build's gate does not name
   * this model"**, which is not the same as either yes or no — it means the
   * answer comes from the server-side flag at runtime, and this extractor cannot
   * see that. Reading a null as a no is exactly the mistake ADR-0016 records.
   */
  readonly takes: Readonly<Record<EffortFlag, boolean | null>>
}

/** Every model id a bundle is willing to compare against, as they are spelled. */
const MODEL_ID = /"(claude-[a-z0-9.-]+)"/g

/**
 * A `return` of a minified boolean, either spelling.
 *
 * `!0` and `!1` are what a bundler emits for `true` and `false`, and the plain
 * words are what an unminified build would carry. Both are accepted so that this
 * can be read against a source tree as well as against a shipped bundle — and
 * so that a build which stops minifying does not silently produce a gate with no
 * branches in it, which would report every model as unnamed.
 */
const RETURNS = /return\s*(!0|!1|true|false)\b/g

/**
 * The gate for one flag, cut out of the bundle at brace balance.
 *
 * A flag is passed more than once, and that is the normal shape rather than an
 * ambiguity: against 2.1.220 each name is asked about twice inside its own gate
 * — once of the deployment's flag store and once of the model's own entitlements
 * (`Ede(e,"effort")` and `M$(r,"effort")`). So the rule is not "one call site",
 * it is **one enclosing function**: every site must resolve to the same body, and
 * a build where they do not is one whose gate has been split or duplicated, which
 * is precisely a change somebody has to look at.
 *
 * @throws if the flag is passed nowhere, if its call sites are in more than one
 * function, or if a site cannot be resolved to a balanced body. Every one of
 * those is a build whose shape has moved, and a build whose shape has moved is
 * the case this file exists to be told about rather than to cope with.
 */
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

/**
 * Every index at which the flag is passed as an argument.
 *
 * Matched as `,"<flag>")` rather than as the bare string, because the bundle
 * carries these words in other places — a description, a settings key, a
 * telemetry name — and a bare match would find them. What identifies the gate is
 * the *call*: something is being asked whether this flag is on.
 */
function callSites(bundle: string, flag: EffortFlag): number[] {
  const call = new RegExp(`,\\s*"${flag}"\\s*\\)`, 'g')
  return [...bundle.matchAll(call)].map((match) => match.index)
}

/**
 * The smallest balanced `{…}` block containing an index, plus its `function`
 * header where there is one.
 *
 * **This is the whole safety property of the extractor**, and it is the thing
 * the first version got wrong: a fixed-size window either side of the call site
 * reads whatever happens to be adjacent, and what is adjacent in a bundle is the
 * next function. Balance is what makes "the function this call is in" a fact
 * rather than a guess about byte distances.
 *
 * @throws if the braces around the site do not balance inside the bundle, which
 * is a file that has been truncated or is not JavaScript at all.
 */
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
  // Back over `function name(args)` or `(args)=>` so the printed source reads as
  // a function rather than as a bare block. Best-effort by design: it changes
  // nothing about what is extracted, since both lists are read from inside the
  // braces, and a header this cannot find costs a human some context and nothing
  // else.
  const header = bundle.slice(Math.max(0, open - 120), open)
  const from = header.lastIndexOf('function ')
  return (from === -1 ? '' : header.slice(from)) + bundle.slice(open, close + 1)
}

/** The `{` that opens the innermost block containing `index`. */
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

/** The `}` that closes the block opened at `open`. */
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

/**
 * The model ids on each branch of a gate, split by what that branch returns.
 *
 * Every model id up to a `return !1` belongs to the refusing branch and every id
 * up to a `return !0` to the allowing one, reading left to right — which is the
 * order a minified chain of `||` comparisons is written in, and the order the
 * measured gate above has.
 *
 * Deliberately not a parser. It is a reading, it is reported as one, and the
 * function it read is printed underneath so that a person can disagree with it.
 */
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
    // The first `return` *after* this comparison is the one it decides, because
    // a comparison is written before the branch it guards.
    const decides = returns.find(({ at }) => at > match.index)
    if (decides === undefined) continue
    ;(decides.value ? allowed : refused).push(model)
  }
  return { refused: unique(refused), allowed: unique(allowed) }
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)]
}

/**
 * One row per model asked about, read off every flag's gate.
 *
 * Asked about roma's own Model Menu rather than about everything the bundle
 * names, because that is the question: the Matrix says which models *a Session
 * roma serves* takes an effort on, and a model no Caller can reach is not one
 * roma has anything to record about.
 */
export function effortMatrix(
  bundle: string,
  models: readonly string[],
): { rows: MatrixRow[]; gates: FlagGate[] } {
  // Read once and handed on, rather than read again by the report: the gates are
  // both what the rows are derived from and what a person checks the rows
  // against, and two readings of one bundle are two things that can disagree.
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

/** What one gate says about one model: named-and-refused, named-and-allowed, or unnamed. */
function verdictFor(gate: FlagGate, model: string): boolean | null {
  if (gate.refused.includes(model)) return false
  if (gate.allowed.includes(model)) return true
  return null
}

/**
 * The report a person reads before editing `EFFORT_MATRIX`, in full.
 *
 * Every gate's source underneath every table, because the tables are the part
 * that can be wrong. The reader is checking a reading, not receiving a result.
 *
 * @throws if there is nothing to report on. Zero models means the caller asked
 * about an empty Menu, and a report with an empty table reads as "nothing takes
 * an effort".
 */
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
