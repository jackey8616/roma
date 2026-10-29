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

describe('the drift workflow makes its own label [fence:drift-creates-its-label]', () => {
  it('creates the label, idempotently, before anything reads it', () => {
    const why =
      'The drift report must create its label with --force before it lists or files by it ' +
      '(#59). A first run in a repository that has never had the label would otherwise fail ' +
      'on `gh issue list --label`, and the stale pin goes unreported.'
    const drift = readFileSync(`${root}.github/workflows/claude-code-drift.yml`, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    const created = drift.search(/gh label create "\$\{LABEL\}" --force/)
    const used = drift.search(/--label "\$\{LABEL\}"|--label \$LABEL/)

    expect(created, why).toBeGreaterThan(-1)
    expect(used, why).toBeGreaterThan(created)
  })
})

describe('the required checks keep their names [fence:required-check-names]', () => {
  it.each(['typecheck, test, build', 'no two ADRs take one number'])(
    'ci.yml still has a job named %s',
    (name) => {
      const why =
        `The "main: CI must pass, squash only" ruleset requires a check named "${name}" ` +
        '(ADR-0031). Renaming the job retires the status the ruleset waits for, and every ' +
        'pull request blocks on a check that never reports again.'
      const ci = readFileSync(`${root}.github/workflows/ci.yml`, 'utf8')

      expect(ci, why).toContain(`    name: ${name}\n`)
    },
  )
})
