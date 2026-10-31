import { describe, expect, it } from 'vitest'
import { containment, matching } from '../test/support/sources.js'

const GITHUB_SPECIFIC = [/github/i, /\bgh\b/, /x-access-token/, /\bpull request\b/i]

describe('everything that knows GitHub exists lives in one directory', () => {
  it('names it nowhere else', () => {
    const offenders = matching(containment('github').outside, GITHUB_SPECIFIC)

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  it('would notice, which is why the directory it excludes trips it', () => {
    const named = matching(containment('github').inside, GITHUB_SPECIFIC)

    expect(named.length).toBeGreaterThan(0)
  })
})
