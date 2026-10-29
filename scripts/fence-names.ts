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
  /** `roma/<rule>` names. */
  readonly rules: ReadonlySet<string>
}

/** Every fence the free run carries, read from the repository at `root`. */
export function fencesIn(root: string, rules: Iterable<string>): Fences {
  const tests = new Map<string, string>()
  for (const file of testFiles(root)) {
    for (const [, id] of readFileSync(join(root, file), 'utf8').matchAll(
      /\[fence:([a-z0-9-]+)\]/g,
    )) {
      tests.set(`fence:${id}`, file)
    }
  }
  return { tests, rules: new Set([...rules].map((rule) => `roma/${rule}`)) }
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
