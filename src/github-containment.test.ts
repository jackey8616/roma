import { describe, expect, it } from 'vitest'
import { containment, matching } from '../test/support/sources.js'

/**
 * GitHub is named under `src/github/`, and nowhere else.
 *
 * A second containment test rather than a line added to the Core's Channel
 * denylist, and ADR-0008 argues the difference: that test says the Core never
 * names a **Channel**, and explains itself in terms of "Google Chat is the first
 * road, not the destination". GitHub is not a road — nobody talks to roma
 * through it; roma reaches out. Smuggling it into that list would make that
 * test's own explanation untrue, and one invariant asked to mean two things
 * stops explaining either.
 *
 * What this keeps is the testing seam. The Core sees a Minter and a socket, and
 * behind that port the wiring test can still assemble roma out of real parts
 * while the free run stays free of anything that needs a private key.
 */

/**
 * Every way `src/` could name the forge outside `src/github/`.
 *
 * **Never put `JWT` back on this list.** It was only ever a proxy — a JWT is a
 * signed token format rather than GitHub's — and since ADR-0015 the agent's
 * cloud signs an assertion of exactly the same shape, so the word here would
 * leave `src/cloud/` unable to spell the grant type Google's exchange requires.
 * These four name the product rather than a technique, which is what this rule
 * was always about.
 */
const GITHUB_SPECIFIC = [/github/i, /\bgh\b/, /x-access-token/, /\bpull request\b/i]

describe('everything that knows GitHub exists lives in one directory', () => {
  it('names it nowhere else', () => {
    const offenders = matching(containment('github').outside, GITHUB_SPECIFIC)

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  // Without this the test above passes for the wrong reason the day somebody
  // narrows the denylist or breaks the comment stripping: a rule that matches
  // nothing anywhere reports containment it is not checking.
  it('would notice, which is why the directory it excludes trips it', () => {
    const named = matching(containment('github').inside, GITHUB_SPECIFIC)

    expect(named.length).toBeGreaterThan(0)
  })
})
