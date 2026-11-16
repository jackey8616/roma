import { describe, expect, it } from 'vitest'
import {
  driftReport,
  labelFor,
  PINS,
  pinNamed,
  pinnedVersion,
  publishedVersion,
} from './pin-drift.js'

const LOUD =
  'The drift check must end red on anything it cannot read — no ARG, a commented or ' +
  'unresolvable pin, two pins, a registry document with no exact version — and be quiet only ' +
  'on a successful comparison (ADR-0007, #52). A check that swallowed its own failures would ' +
  'pass forever while watching nothing, and a green tick reads as "the pin is current".'

const UNNAMED =
  'The drift check must end red when it is asked about a pin it does not know — a typo in a ' +
  'caller, a key off the prototype, no name at all (#217). Answering for no pin would pass ' +
  'every week while watching nothing.'

const CASES = [
  {
    name: 'claude-code',
    arg: 'CLAUDE_CODE_VERSION',
    pkg: '@anthropic-ai/claude-code',
    pinned: '2.1.220',
    published: '2.1.221',
    runs: /seam 2/,
    window: /Claude Code's \*\*Shared Window\*\*, not Codex's/,
    evidence: ['Dockerfile', 'docs/adr/0007-a-container-image-pinned-to-one-claude-code.md'],
  },
  {
    name: 'codex',
    arg: 'CODEX_VERSION',
    pkg: '@openai/codex',
    pinned: '0.160.0',
    published: '0.160.1',
    runs: /Codex live tests/,
    window: /Codex's \*\*Shared Window\*\*, not Claude Code's/,
    evidence: ['Dockerfile', 'docs/codex-app-server-verification.md'],
  },
] as const

describe('a pin is named, not guessed [fence:drift-check-fails-loud]', () => {
  it('knows the pins these cases cover', () => {
    const why =
      'Every pin the drift check knows must be exercised here (ADR-0031, #217). A pin added ' +
      'to the table without a case is a pin whose parsing nothing has shown red.'

    expect([...PINS.keys()], why).toEqual(CASES.map(({ name }) => name))
  })

  it.each(['constructor', 'toString', '__proto__', 'gh', ''])(
    'refuses %o rather than watching nothing',
    (name) => {
      expect(() => pinNamed(name), UNNAMED).toThrow(/no pin is named/)
    },
  )

  it('refuses no name at all', () => {
    expect(() => pinNamed(undefined), UNNAMED).toThrow(/no pin is named/)
  })
})

describe.each(CASES)('the $name pin', (c) => {
  const pin = pinNamed(c.name)
  const dockerfile = `# The pin, exact rather than floating.
#
# Moving this number is a re-verification event, not a dependency bump.
ARG ${c.arg}=${c.pinned}

FROM node:22-slim AS runtime

ARG ${c.arg}
RUN npm install --global ${c.pkg}@\${${c.arg}}
`

  function report(): { title: string; body: string } {
    return driftReport(pin, { pinned: c.pinned, published: c.published, evidence: [...c.evidence] })
  }

  describe('is read from the Dockerfile, not restated [fence:drift-check-fails-loud]', () => {
    it('reads the version the ARG assigns', () => {
      expect(pinnedVersion(pin, dockerfile)).toBe(c.pinned)
    })

    it('reads its own ARG and not the other Runtime’s', () => {
      const other = CASES.find(({ name }) => name !== c.name)!.arg

      expect(pinnedVersion(pin, `ARG ${other}=9.9.9\n${dockerfile}`)).toBe(c.pinned)
    })

    it('refuses a Dockerfile with no ARG line rather than reporting nothing', () => {
      expect(() => pinnedVersion(pin, 'FROM node:22-slim\n'), LOUD).toThrow(
        new RegExp(`ARG ${c.arg}`),
      )
    })

    it('refuses a commented-out pin, which assigns nothing', () => {
      expect(() => pinnedVersion(pin, `# ARG ${c.arg}=${c.pinned}\n`), LOUD).toThrow(
        new RegExp(`ARG ${c.arg}`),
      )
    })

    it.each(['latest', `^${c.pinned}`, '~2.1', '${UPSTREAM}', ''])(
      'refuses %o, which is not a version this check can compare',
      (value) => {
        expect(() => pinnedVersion(pin, `ARG ${c.arg}=${value}\n`), LOUD).toThrow(new RegExp(c.arg))
      },
    )

    it('refuses two assignments rather than picking one of them', () => {
      const twice = `ARG ${c.arg}=${c.pinned}\nARG ${c.arg}=${c.published}\n`

      expect(() => pinnedVersion(pin, twice), LOUD).toThrow(/twice|two/i)
    })
  })

  describe('is compared against the registry document [fence:drift-check-fails-loud]', () => {
    it('reads the version of the latest dist-tag', () => {
      expect(publishedVersion(pin, { name: c.pkg, version: c.published })).toBe(c.published)
    })

    it.each([
      ['a document with no version', { name: c.pkg }],
      ['a version that is not a string', { version: 2 }],
      ['a range where a version belongs', { version: `^${c.published}` }],
      ['a prerelease where a release belongs', { version: `${c.published}-alpha.7` }],
      ['an error document', { error: 'Not found' }],
      ['nothing at all', null],
    ])('refuses %s rather than comparing against it', (_, document) => {
      expect(() => publishedVersion(pin, document), LOUD).toThrow(/registry/i)
    })
  })

  describe('reports the cost at the same moment as the version', () => {
    it('names the Runtime and both versions', () => {
      expect(report().title).toContain(pin.runtime)
      expect(report().title).toContain(c.published)
      expect(report().title).toContain(c.pinned)
      expect(report().body).toContain(c.pkg)
      expect(report().body).toContain(c.published)
      expect(report().body).toContain(c.pinned)
    })

    it('says in one breath which live tests moving the pin means, and whose Shared Window', () => {
      const both = paragraphsOf(report().body).filter(
        (paragraph) => c.runs.test(paragraph) && c.window.test(paragraph),
      )

      expect(both).not.toEqual([])
    })

    it('lists every file that carries evidence about the pinned version', () => {
      for (const file of c.evidence) {
        expect(report().body).toContain(file)
      }
    })

    it('refuses to report no evidence at all', () => {
      expect(() =>
        driftReport(pin, { pinned: c.pinned, published: c.published, evidence: [] }),
      ).toThrow(/evidence/i)
    })

    it('files under a label of its own, which the open report already carries', () => {
      const why =
        'The workflow finds the open report by its label (#52), and the Claude Code reports ' +
        'filed before #217 carry `claude-code-drift`. A label renamed is an open report the ' +
        'next run cannot find, and a second one filed beside it.'

      expect(labelFor(pin).label, why).toBe(`${c.name}-drift`)
      expect(labelFor(pin).description).toContain(pin.runtime)
    })
  })
})

function paragraphsOf(body: string): string[] {
  return body.split(/\n{2,}/)
}
