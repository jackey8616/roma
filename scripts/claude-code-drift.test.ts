import { describe, expect, it } from 'vitest'
import { driftReport, pinnedClaudeCode, publishedClaudeCode } from './claude-code-drift.js'

const DOCKERFILE = `# The Claude Code this image carries, exact rather than floating.
#
# Moving this number is a re-verification event, not a dependency bump.
ARG CLAUDE_CODE_VERSION=2.1.220

FROM node:22-slim AS runtime

ARG CLAUDE_CODE_VERSION
RUN npm install --global @anthropic-ai/claude-code@\${CLAUDE_CODE_VERSION}
`

const LOUD =
  'The drift check must end red on anything it cannot read — no ARG, a commented or ' +
  'unresolvable pin, two pins, a registry document with no exact version — and be quiet only ' +
  'on a successful comparison (ADR-0007, #52). A check that swallowed its own failures would ' +
  'pass forever while watching nothing, and a green tick reads as "the pin is current".'

describe('the pin is read from the Dockerfile, not restated [fence:drift-check-fails-loud]', () => {
  it('reads the version the ARG assigns', () => {
    expect(pinnedClaudeCode(DOCKERFILE)).toBe('2.1.220')
  })

  it('refuses a Dockerfile with no ARG line rather than reporting nothing', () => {
    expect(() => pinnedClaudeCode('FROM node:22-slim\n'), LOUD).toThrow(/ARG CLAUDE_CODE_VERSION/)
  })

  it('refuses a commented-out pin, which assigns nothing', () => {
    expect(() => pinnedClaudeCode('# ARG CLAUDE_CODE_VERSION=2.1.220\n'), LOUD).toThrow(
      /ARG CLAUDE_CODE_VERSION/,
    )
  })

  it.each(['latest', '^2.1.220', '~2.1', '${UPSTREAM}', ''])(
    'refuses %o, which is not a version this check can compare',
    (value) => {
      expect(() => pinnedClaudeCode(`ARG CLAUDE_CODE_VERSION=${value}\n`), LOUD).toThrow(
        /CLAUDE_CODE_VERSION/,
      )
    },
  )

  it('refuses two assignments rather than picking one of them', () => {
    const twice = `ARG CLAUDE_CODE_VERSION=2.1.220\nARG CLAUDE_CODE_VERSION=2.1.221\n`

    expect(() => pinnedClaudeCode(twice), LOUD).toThrow(/twice|two/i)
  })
})

describe('the published version is read from the registry document [fence:drift-check-fails-loud]', () => {
  it('reads the version of the latest dist-tag', () => {
    expect(publishedClaudeCode({ name: '@anthropic-ai/claude-code', version: '2.1.221' })).toBe(
      '2.1.221',
    )
  })

  it.each([
    ['a document with no version', { name: '@anthropic-ai/claude-code' }],
    ['a version that is not a string', { version: 2 }],
    ['a range where a version belongs', { version: '^2.1.221' }],
    ['an error document', { error: 'Not found' }],
    ['nothing at all', null],
  ])('refuses %s rather than comparing against it', (_, document) => {
    expect(() => publishedClaudeCode(document), LOUD).toThrow(/registry/i)
  })
})

describe('the report makes the cost visible at the same moment as the version', () => {
  it('names both versions', () => {
    expect(report().title).toContain('2.1.221')
    expect(report().title).toContain('2.1.220')
    expect(report().body).toContain('2.1.221')
    expect(report().body).toContain('2.1.220')
  })

  it('says in one breath that moving the pin means seam 2 against the Shared Window', () => {
    const both = paragraphsOf(report().body).filter(
      (paragraph) => /seam 2/.test(paragraph) && /Shared Window/.test(paragraph),
    )

    expect(both).not.toEqual([])
  })

  it('lists every file that carries evidence about the pinned version', () => {
    for (const file of EVIDENCE) {
      expect(report().body).toContain(file)
    }
  })

  it('refuses to report no evidence at all', () => {
    expect(() => driftReport({ pinned: '2.1.220', published: '2.1.221', evidence: [] })).toThrow(
      /evidence/i,
    )
  })
})

const EVIDENCE = ['Dockerfile', 'docs/adr/0007-a-container-image-pinned-to-one-claude-code.md']

function report(): { title: string; body: string } {
  return driftReport({ pinned: '2.1.220', published: '2.1.221', evidence: EVIDENCE })
}

function paragraphsOf(body: string): string[] {
  return body.split(/\n{2,}/)
}
