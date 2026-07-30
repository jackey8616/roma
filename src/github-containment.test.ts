import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sources, type Source } from '../test/support/sources.js'

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

const GITHUB_SPECIFIC = [/github/i, /\bgh\b/, /x-access-token/, /\bJWT\b/i, /\bpull request\b/i]

describe('everything that knows GitHub exists lives in one directory', () => {
  it('names it nowhere else', () => {
    const offenders = allowed().filter(({ source }) =>
      GITHUB_SPECIFIC.some((pattern) => pattern.test(code(source))),
    )

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  // Without this the test above passes for the wrong reason the day somebody
  // narrows the denylist or breaks the comment stripping: a rule that matches
  // nothing anywhere reports containment it is not checking.
  it('would notice, which is why the directory it excludes trips it', () => {
    const named = sources()
      .filter(({ file }) => file.split(sep).includes('github'))
      .filter(({ source }) => GITHUB_SPECIFIC.some((pattern) => pattern.test(code(source))))

    expect(named.length).toBeGreaterThan(0)
  })
})

/**
 * A file with its comments taken out, so that every claim here is about what the
 * file *does*.
 *
 * The idiom `src/packaging.test.ts` already uses, for its reason: half of these
 * files explain themselves by naming the very thing they must not contain — that
 * the Minter is a port because a GitHub REST call cannot be in the Core, that
 * `gh` announces no repository and that is why nothing is down-scoped. Reading
 * the prose as if it were an instruction would make documenting a decision the
 * way to break the test that keeps it.
 *
 * Line comments are recognised only at the start of a line, so that a `//` inside
 * a URL in real code is not mistaken for one.
 */
function code(source: string): string {
  let inBlock = false
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      if (inBlock) {
        inBlock = !trimmed.includes('*/')
        return false
      }
      if (trimmed.startsWith('/*')) {
        inBlock = !trimmed.includes('*/')
        return false
      }
      return !trimmed.startsWith('//')
    })
    .join('\n')
}

/**
 * Every source file the rule binds: all of `src/`, minus `src/github/`, minus
 * the composition root.
 *
 * The composition root is excluded for the reason it already names a Channel:
 * assembling roma means saying what it is assembled out of, and something has to
 * import the Minter by the name of the directory it lives in. It is one file, it
 * is named here rather than by pattern, and everything it hands to `startRoma`
 * is a value the Core reads without knowing where it came from.
 *
 * Tests are outside this already — `sources()` drops them — which is what lets
 * `wiring.test.ts` use the real announcement over a fake Minter.
 */
function allowed(): Source[] {
  return sources().filter(({ file }) => {
    const parts = file.split(sep)
    return !parts.includes('github') && !COMPOSITION_ROOTS.includes(file)
  })
}

/** One per deployment, and today there is one deployment. */
const COMPOSITION_ROOTS = [['channels', 'google-chat', 'main.ts'].join(sep)]
