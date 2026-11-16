import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PINS } from './pin-drift.js'

const root = fileURLToPath(new URL('..', import.meta.url))

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

function workflow(name: string): string {
  return readFileSync(`${root}.github/workflows/${name}`, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

describe('the drift workflow makes its own label [fence:drift-creates-its-label]', () => {
  it('creates the label, idempotently, before anything reads it', () => {
    const why =
      'The drift report must create its label with --force before it lists or files by it ' +
      '(#59). A first run in a repository that has never had the label would otherwise fail ' +
      'on `gh issue list --label`, and the stale pin goes unreported.'
    const drift = workflow('pin-drift.yml')
    const created = drift.search(/gh label create "\$\{LABEL\}" --force/)
    const used = drift.search(/--label "\$\{LABEL\}"|--label \$LABEL/)

    expect(created, why).toBeGreaterThan(-1)
    expect(used, why).toBeGreaterThan(created)
  })
})

describe('every pin has a drift watch of its own [fence:drift-watches-every-pin]', () => {
  const why =
    'The image pins Claude Code and Codex, and moving either is a re-verification event ' +
    '(ADR-0007, ADR-0026 *The pins*, #217). A pin the script knows and no workflow runs on a ' +
    'schedule is a pin falling behind with nobody told; a caller without the one-at-a-time ' +
    'group files two reports when a scheduled and a dispatched run overlap (#52).'

  it('knows both Runtimes’ pins', () => {
    expect([...PINS.keys()], why).toEqual(['claude-code', 'codex'])
  })

  it.each([...PINS.keys()])(
    'runs the shared job for the %s pin, weekly and one at a time',
    (pin) => {
      const caller = workflow(`${pin}-drift.yml`)

      expect(caller, why).toContain("  schedule:\n    - cron: '0 7 * * 1'\n  workflow_dispatch:\n")
      expect(caller, why).toContain('permissions:\n  contents: read\n  issues: write\n')
      expect(caller, why).toContain(
        `concurrency:\n  group: ${pin}-drift\n  cancel-in-progress: false\n`,
      )
      expect(caller, why).toContain(
        `    uses: ./.github/workflows/pin-drift.yml\n    with:\n      pin: ${pin}\n`,
      )
    },
  )

  it.each([...PINS.keys()])('has an npm script that checks the %s pin', (pin) => {
    const { scripts } = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(scripts[`check:${pin}-drift`], why).toBe(`tsx scripts/check-pin-drift.ts ${pin}`)
  })

  it('runs the npm script the caller named', () => {
    expect(workflow('pin-drift.yml'), why).toContain('run: npm run "check:${PIN}-drift"')
    expect(workflow('pin-drift.yml'), why).toContain('PIN: ${{ inputs.pin }}')
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
