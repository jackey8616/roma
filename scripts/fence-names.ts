import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import freeRun from '../vitest.config.js'

export const ENFORCED_BY =
  /Enforced by\s+(`[^`]+`(?:\s*(?:,\s*(?:and\s+)?|and\s+)(?:by\s+)?`[^`]+`)*)/g

export interface Cited {
  readonly name: string
  readonly index: number
}

export function citedIn(text: string): Cited[] {
  return [...text.matchAll(ENFORCED_BY)].flatMap((match) =>
    [...match[1]!.matchAll(/`([^`]+)`/g)].map(([, name]) => ({ name: name!, index: match.index })),
  )
}

export interface Fences {
  readonly tests: ReadonlyMap<string, string>
  readonly claimedTwice: ReadonlyMap<string, readonly string[]>
  readonly rules: ReadonlySet<string>
}

export interface TestSource {
  readonly file: string
  readonly text: string
}

export function fencesIn(root: string, rules: Iterable<string>): Fences {
  const sources = testFiles(root).map((file) => ({
    file,
    text: readFileSync(join(root, file), 'utf8'),
  }))
  return fencesFrom(sources, rules)
}

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

export function unresolved(name: string, fences: Fences): string | null {
  if (name.startsWith('fence:')) {
    return fences.tests.has(name) ? null : `no test in the free run carries [${name}] in its title`
  }
  if (name.startsWith('roma/')) {
    return fences.rules.has(name) ? null : `roma's ESLint plugin has no rule ${name}`
  }
  return `\`${name}\` is not a check name: cite fence:<id> or roma/<rule>`
}

function testFiles(root: string): string[] {
  const { include = [], exclude = [] } = freeRun.test ?? {}
  return globSync(include, { cwd: root, exclude }).sort()
}
