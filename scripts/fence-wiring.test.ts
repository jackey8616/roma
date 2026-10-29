import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

/** The steps of the `checks` job, as the text between its header and the next job. */
function checksJob(): string {
  const ci = readFileSync(`${root}.github/workflows/ci.yml`, 'utf8')
  const start = ci.indexOf('\n  checks:\n')
  const next = ci.slice(start + 1).search(/\n  [a-z-]+:\n/)
  return ci.slice(start, next === -1 ? undefined : start + 1 + next)
}

describe('CI runs the checks that hold the fence [fence:ci-runs-the-fences]', () => {
  const why =
    'The comment whitelist and the ADR enforcer check must run in the `checks` job, under ' +
    'its existing name (ADR-0031). A step removed is a fence nobody checks; a job renamed ' +
    'retires the status a branch protection rule waits for, and every pull request blocks.'

  it('keeps the name a branch protection rule requires', () => {
    expect(checksJob(), why).toContain('name: typecheck, test, build')
  })

  it.each(['npm run lint', 'npm run check:adr-enforcers'])('runs %s', (step) => {
    expect(checksJob(), why).toContain(`- run: ${step}\n`)
  })
})
