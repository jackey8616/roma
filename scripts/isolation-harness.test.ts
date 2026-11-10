import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REACHES_ONE_SESSION_COULD_MAKE_INTO_ANOTHER = [
  'work-dir-read',
  'enclosure-read',
  'transcript-read',
  'tmp-read',
  'work-dir-write',
  'transcript-write',
  'environ-read',
  'signal',
  'shim-claim',
]

const why =
  'ADR-0036, GHSA-mqhq-64x8-xj73, GHSA-4vw6-r2rj-xcqf: scripts/verify-image.sh §9 is the only ' +
  'place Session isolation is proved — against the built image, its real kernel and roma’s ' +
  'compiled spawn path. Each reach must be probed by scripts/isolation-harness.mjs, required ' +
  'BLOCKED for the other Session and REACHED for the control; drop one and the image stops ' +
  'being asked about it.'

describe('the image is asked whether one Session reaches another [fence:sessions-cannot-reach-each-other]', () => {
  it('runs the isolation harness against the built image', () => {
    expect(verifyImage(), why).toContain('isolation-harness.mjs')
  })

  it.each(REACHES_ONE_SESSION_COULD_MAKE_INTO_ANOTHER)('asks about %s', (reach) => {
    const listed = /isolation_checks=\(([^)]*)\)/.exec(verifyImage())?.[1]?.split(/\s+/) ?? []

    expect(listed, why).toContain(reach)
    expect(harness(), why).toMatch(new RegExp(`check ${reach}\\b|${reach} \\$\\{`))
  })

  it('requires the other Session BLOCKED and the control REACHED', () => {
    expect(verifyImage(), why).toContain('"a ${check} BLOCKED"')
    expect(verifyImage(), why).toContain('"control ${check} REACHED"')
  })
})

function verifyImage(): string {
  return readFileSync(fileURLToPath(new URL('verify-image.sh', import.meta.url)), 'utf8')
}

function harness(): string {
  return readFileSync(fileURLToPath(new URL('isolation-harness.mjs', import.meta.url)), 'utf8')
}
