import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The three claims ADR-0007 makes about the image that nothing else keeps.
 *
 * Written in the idiom `src/channels/google-chat/provisioning.test.ts` uses —
 * read the file, fail on what must not be in it — because all three are claims
 * about a repository rather than about behaviour, and every one of them is the
 * kind that stays green while it stops being true.
 *
 * What is *not* here is anything that needs Docker: `claude --version` inside the
 * image and roma's refusal on an empty environment are checked by the workflows,
 * against a built image, because that is the only place either question can
 * actually be asked. These three can be asked from a file, so they are asked in
 * the free run rather than at the end of a five-minute build.
 */

/**
 * The Claude Code every measurement in this repo was taken against.
 *
 * A second copy of the number in the Dockerfile, on purpose. ADR-0003 holds that
 * a capture is evidence about v2.1.220 and nothing else; moving the pin is a
 * re-verification event that costs Shared Window money, so the two copies
 * disagreeing is the whole point — editing the Dockerfile alone turns the run
 * red and this file is where the reason is written down.
 */
const CLAUDE_CODE_VERSION = '2.1.220'

describe('the image carries its own Claude Code, pinned exactly', () => {
  it('installs the version every measurement in this repo was taken against', () => {
    // Interpolated into a pattern, so the version's dots have to stop being
    // wildcards. Unescaped, an `ARG CLAUDE_CODE_VERSION=2X1X220` would satisfy
    // this test — which is the one thing it exists to refuse.
    const pinned = CLAUDE_CODE_VERSION.replaceAll('.', String.raw`\.`)
    expect(dockerfile()).toMatch(new RegExp(`^ARG CLAUDE_CODE_VERSION=${pinned}$`, 'm'))
  })

  it('installs that version rather than whatever npm would resolve today', () => {
    // Every mention of the package, with whatever follows it. A range, a
    // dist-tag or a dropped `@` all resolve to the pinned version on the day
    // somebody looks and to something else later, which is the entire failure
    // the pin exists to stop — so the specifier is read rather than resolved.
    //
    // The expected value is a Dockerfile `ARG` reference and not a version:
    // together with the assertion above, which is what fixes what that `ARG`
    // holds, the pair is what makes the install exact.
    const specifiers = [...dockerfile().matchAll(/@anthropic-ai\/claude-code(\S*)/g)].map(
      ([, specifier]) => specifier,
    )

    expect(specifiers).toEqual(['@${CLAUDE_CODE_VERSION}'])
  })
})

describe('the image defaults the one path whose loss is by design', () => {
  it('names a work root, the one a weekly reclaim deletes on purpose', () => {
    expect(dockerfile()).toMatch(/^\s*ROMA_WORK_ROOT=\S+/m)
  })

  it('sets no audit root and no Claude config dir — losing either is data loss', () => {
    // `readRomaEnv` refuses to start without either, deliberately. An image that
    // helpfully defaulted one would put that data in the container's writable
    // layer, where it vanishes with the container — the Audit Records, which
    // ADR-0002 says are the only place per-user attribution ever exists, or the
    // Transcript, which ADR-0005 says is the only account there is of what an
    // agent did and ADR-0006 says roma deletes nothing from.
    //
    // Both directories are made and owned all the same, which is a different
    // act: an empty named volume mounted over a path the image never created
    // comes out `root:root` and roma runs as `node`. So this looks for the
    // assignment rather than the name — and for both spellings of one, because
    // `ENV NAME value` without the `=` is legacy Dockerfile syntax that still
    // works and would otherwise slip past.
    expect(dockerfile()).not.toMatch(/ROMA_AUDIT_ROOT[\s=]/)
    expect(dockerfile()).not.toMatch(/ROMA_CLAUDE_CONFIG_DIR[\s=]/)
  })
})

describe('nothing CI runs can reach seam 2', () => {
  it('runs no seam 2 test and is handed no Shared Window token', () => {
    const offenders = automation().filter(({ source }) =>
      SEAM_2.some((pattern) => pattern.test(withoutComments(source))),
    )

    expect(offenders.map(({ file }) => file)).toEqual([])
  })
})

/**
 * Every way CI could start spending Shared Window quota.
 *
 * The first two are the tests themselves — the opt-in script and the file suffix
 * its config selects on. The third is the token, which is the one that matters:
 * without it seam 2 fails rather than runs, so automation that never sees one
 * cannot spend anything even if somebody wires the script up by hand. It is also
 * the pattern that catches the version of this that is not a mistake, which is a
 * release job "proving the image works" by booting roma for real.
 */
const SEAM_2 = [/\btest:seam2\b/, /\.live\.test\b/, /\bCLAUDE_CODE_OAUTH_TOKEN\b/]

/** The Dockerfile as Docker reads it: the instructions, without the commentary. */
function dockerfile(): string {
  return withoutComments(readFileSync(fromRoot('Dockerfile'), 'utf8'))
}

/**
 * Everything CI executes: the workflows, and the scripts they hand work to.
 *
 * `scripts/` is here because both workflows delegate their image checks to it,
 * and a guard that stopped at the YAML would be a fence with a gate in it —
 * `docker run -e …` inside a shell script spends money exactly as well as a
 * workflow step does.
 */
function automation(): { file: string; source: string }[] {
  return [
    ...filesIn('.github/workflows', (file) => file.endsWith('.yml') || file.endsWith('.yaml')),
    ...filesIn('scripts', () => true),
  ]
}

function filesIn(
  directory: string,
  wanted: (file: string) => boolean,
): { file: string; source: string }[] {
  const path = fromRoot(directory)
  return readdirSync(path)
    .filter(wanted)
    .map((file) => ({
      file: `${directory}/${file}`,
      source: readFileSync(join(path, file), 'utf8'),
    }))
}

/**
 * A file with its whole-line comments taken out.
 *
 * So that every claim here is about what the file *does*. All three of these
 * files explain themselves at length, and several of them explain themselves by
 * naming the exact thing they must not contain — `@latest`, the token, the audit
 * root. Reading the prose as if it were an instruction would make documenting a
 * decision the way to break the test that keeps it.
 */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

function fromRoot(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url))
}
