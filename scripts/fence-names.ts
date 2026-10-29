/**
 * Which checks exist, by the name a comment or an ADR cites them by.
 *
 * One resolver for both citers — `roma/comment-whitelist` and
 * `scripts/check-adr-enforcers.ts` — so the two cannot disagree about whether
 * `Enforced by` names something real (ADR-0031).
 *
 * A name is one of:
 *
 * - `fence:<id>` — a test whose title carries `[fence:<id>]`, in a file the free
 *   run executes, read from `vitest.config.ts` itself. A test only seam 2 runs
 *   does not count: CI never runs it, so it would be cited as enforcing something
 *   nothing checks.
 * - `roma/<rule>` — a rule in roma's own ESLint plugin.
 */

import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import freeRun from '../vitest.config.js'

/** How a comment or an ADR says which check holds a rule. */
export const ENFORCED_BY = /Enforced by\s+`([^`]+)`/g

/** The checks that exist, and where each one lives. */
export interface Fences {
  /** `fence:<id>` → the test file that carries it. */
  readonly tests: ReadonlyMap<string, string>
  /**
   * `fence:<id>` → every file that carries it, for a name more than one file
   * claims. A citation of it would name whichever was read last.
   */
  readonly claimedTwice: ReadonlyMap<string, readonly string[]>
  /** `roma/<rule>` names. */
  readonly rules: ReadonlySet<string>
}

/** One test file, by path, and its text. */
export interface TestSource {
  readonly file: string
  readonly text: string
}

/** Every fence the free run carries, read from the repository at `root`. */
export function fencesIn(root: string, rules: Iterable<string>): Fences {
  const sources = testFiles(root).map((file) => ({
    file,
    text: readFileSync(join(root, file), 'utf8'),
  }))
  return fencesFrom(sources, rules)
}

/** The fences these test files carry, and the rules roma's plugin has. */
export function fencesFrom(sources: readonly TestSource[], rules: Iterable<string>): Fences {
  const carriers = new Map<string, Set<string>>()
  for (const { file, text } of sources) {
    for (const [, id] of text.matchAll(/\[fence:([a-z0-9-]+)\]/g)) {
      const name = `fence:${id}`
      carriers.set(name, (carriers.get(name) ?? new Set()).add(file))
    }
  }
  const tests = new Map([...carriers].map(([name, files]) => [name, [...files].at(-1)!]))
  const claimedTwice = new Map(
    [...carriers].filter(([, files]) => files.size > 1).map(([name, files]) => [name, [...files]]),
  )
  return { tests, claimedTwice, rules: new Set([...rules].map((rule) => `roma/${rule}`)) }
}

/** The failure a person reads when two test files claim one fence name. */
export function claimedTwiceMessage(claimedTwice: Fences['claimedTwice']): string {
  const found = [...claimedTwice]
    .map(([name, files]) => `  ${name}: ${files.join(', ')}`)
    .join('\n')
  return `A fence name is carried by more than one test file:

${found}

ADR-0031: a comment or an ADR cites a check by its fence name, so the name has
to pick out one check. Two files carrying it means a citation names whichever
was read last, and deleting either one goes unnoticed. Rename one of them.
`
}

/** Why `name` cannot be cited as a check, or null when it can. */
export function unresolved(name: string, fences: Fences): string | null {
  if (name.startsWith('fence:')) {
    return fences.tests.has(name) ? null : `no test in the free run carries [${name}] in its title`
  }
  if (name.startsWith('roma/')) {
    return fences.rules.has(name) ? null : `roma's ESLint plugin has no rule ${name}`
  }
  return `\`${name}\` is not a check name: cite fence:<id> or roma/<rule>`
}

/** Every test file the free run executes, relative to `root`. */
function testFiles(root: string): string[] {
  const { include = [], exclude = [] } = freeRun.test ?? {}
  return globSync(include, { cwd: root, exclude }).sort()
}
