import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { danglingEnforcers, danglingMessage } from './adr-enforcers.js'
import { fencesIn, type Fences } from './fence-names.js'
import { rules } from './lint/plugin.js'

const FENCES: Fences = {
  tests: new Map([['fence:held', 'src/held.test.ts']]),
  rules: new Set(['roma/comment-whitelist']),
}

describe('an ADR that says a check enforces it [fence:adr-enforcers-exist]', () => {
  it('passes a citation of a fence or a rule that exists', () => {
    const adrs = [
      { file: 'a.md', text: 'Decided.\n\nEnforced by `fence:held`.' },
      { file: 'b.md', text: 'Enforced by `roma/comment-whitelist`.' },
    ]

    expect(danglingEnforcers(adrs, FENCES)).toEqual([])
  })

  it('names the file, line and check of a citation that does not resolve', () => {
    const adrs = [{ file: 'a.md', text: 'Decided.\nEnforced by `fence:renamed-away`.' }]

    expect(danglingEnforcers(adrs, FENCES)).toEqual([
      {
        file: 'a.md',
        line: 2,
        name: 'fence:renamed-away',
        why: 'no test in the free run carries [fence:renamed-away] in its title',
      },
    ])
  })

  it('reads a citation that a line wrap split in two', () => {
    const adrs = [{ file: 'a.md', text: 'Decided. Enforced by\n`fence:gone`.' }]

    expect(danglingEnforcers(adrs, FENCES)).toMatchObject([{ line: 1, name: 'fence:gone' }])
  })

  it('refuses a name that is not a check at all', () => {
    const adrs = [{ file: 'a.md', text: 'Enforced by `code review`.' }]

    expect(danglingEnforcers(adrs, FENCES)[0]?.why).toMatch(/not a check name/)
  })

  it('says why a dangling name matters, and cites ADR-0031', () => {
    const message = danglingMessage(
      danglingEnforcers([{ file: 'a.md', text: 'Enforced by `fence:x`.' }], FENCES),
    )

    expect(message).toContain('a.md:1  fence:x')
    expect(message).toContain('ADR-0031')
  })

  it('finds nothing dangling in this repository', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const dir = join(root, 'docs/adr')
    const adrs = readdirSync(dir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }))
    const dangling = danglingEnforcers(adrs, fencesIn(root, Object.keys(rules)))

    expect(dangling, dangling.length > 0 ? danglingMessage(dangling) : '').toEqual([])
  })
})

describe('which fences the free run carries', () => {
  it('reads them from the files vitest.config.ts runs', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const fences = fencesIn(root, [])

    expect(fences.tests.get('fence:only-rejected-is-spent')).toBe('src/shared-window.test.ts')
    expect(fences.tests.get('fence:comment-whitelist')).toBe(
      'scripts/lint/comment-whitelist.test.ts',
    )
  })
})
