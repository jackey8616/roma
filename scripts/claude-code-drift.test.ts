import { describe, expect, it } from 'vitest'
import { driftReport, pinnedClaudeCode, publishedClaudeCode } from './claude-code-drift.js'

/**
 * The three questions the drift check asks, away from the network and the issue
 * tracker.
 *
 * Everything here is a pure function on purpose, because the failure this check
 * most plausibly dies of is its own silence — a reformatted `ARG` line, a
 * registry document that changed shape, a report that lost the sentence about
 * what moving the pin costs. None of those announce themselves at runtime: they
 * produce a check that passes forever while watching nothing, and a green tick
 * reads as "the pin is current".
 *
 * So the parsing and the wording are asserted here, in the free run, and the
 * entry point (`scripts/check-claude-code-drift.ts`) is left with nothing but
 * I/O: read the file, ask the registry, run the `grep`, hand the answers to
 * these.
 */

/**
 * The `ARG` line as the Dockerfile actually carries it, commentary and all —
 * including the bare `ARG CLAUDE_CODE_VERSION` that re-declares it in the
 * runtime stage, which is the second line in the file that mentions the name and
 * the one an over-eager regex reads instead.
 */
const DOCKERFILE = `# The Claude Code this image carries, exact rather than floating.
#
# Moving this number is a re-verification event, not a dependency bump.
ARG CLAUDE_CODE_VERSION=2.1.220

FROM node:22-slim AS runtime

ARG CLAUDE_CODE_VERSION
RUN npm install --global @anthropic-ai/claude-code@\${CLAUDE_CODE_VERSION}
`

describe('the pin is read from the Dockerfile, not restated', () => {
  it('reads the version the ARG assigns', () => {
    expect(pinnedClaudeCode(DOCKERFILE)).toBe('2.1.220')
  })

  it('refuses a Dockerfile with no ARG line rather than reporting nothing', () => {
    expect(() => pinnedClaudeCode('FROM node:22-slim\n')).toThrow(/ARG CLAUDE_CODE_VERSION/)
  })

  it('refuses a commented-out pin, which assigns nothing', () => {
    // `withoutComments` in `src/packaging.test.ts` exists for the same reason:
    // the Dockerfile explains itself at length, and several of its comments name
    // versions. Reading prose as an instruction is how a check ends up watching
    // a sentence.
    expect(() => pinnedClaudeCode('# ARG CLAUDE_CODE_VERSION=2.1.220\n')).toThrow(
      /ARG CLAUDE_CODE_VERSION/,
    )
  })

  it.each(['latest', '^2.1.220', '~2.1', '${UPSTREAM}', ''])(
    'refuses %o, which is not a version this check can compare',
    (value) => {
      // A pin that has to be resolved before it means anything is a pin this
      // check cannot compare, and comparing it anyway would report drift against
      // a string. Red, and naming what it found.
      expect(() => pinnedClaudeCode(`ARG CLAUDE_CODE_VERSION=${value}\n`)).toThrow(
        /CLAUDE_CODE_VERSION/,
      )
    },
  )

  it('refuses two assignments rather than picking one of them', () => {
    // Which copy won would decide what this check watches, silently, and the
    // whole point of reading the `ARG` is that there is one copy of the number
    // in the Dockerfile.
    const twice = `ARG CLAUDE_CODE_VERSION=2.1.220\nARG CLAUDE_CODE_VERSION=2.1.221\n`

    expect(() => pinnedClaudeCode(twice)).toThrow(/twice|two/i)
  })
})

describe('the published version is read from the registry document', () => {
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
    expect(() => publishedClaudeCode(document)).toThrow(/registry/i)
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
    // The sentence this whole ticket is for. A report that says only "2.1.221 is
    // out" invites exactly the reflex the pin exists to stop.
    //
    // Asserted a paragraph at a time rather than over the whole body, because the
    // body names the Shared Window twice — once as the money re-verification
    // spends, and once to say no workflow here holds a token for it. Two loose
    // `toContain`s are satisfied by the second alone, which is a report that has
    // quietly stopped naming the cost.
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
    // Zero files means the `grep` disagreed with the `ARG` about what the pinned
    // version is, and a report whose evidence section is empty reads as "moving
    // the pin costs nothing" — the one thing it must never say.
    expect(() => driftReport({ pinned: '2.1.220', published: '2.1.221', evidence: [] })).toThrow(
      /evidence/i,
    )
  })
})

/** Two files that name the pinned version, standing in for what the `grep` finds. */
const EVIDENCE = ['Dockerfile', 'docs/adr/0007-a-container-image-pinned-to-one-claude-code.md']

/** One drift, reported. */
function report(): { title: string; body: string } {
  return driftReport({ pinned: '2.1.220', published: '2.1.221', evidence: EVIDENCE })
}

/** The body as a reader takes it in: blank-line-separated blocks. */
function paragraphsOf(body: string): string[] {
  return body.split(/\n{2,}/)
}
