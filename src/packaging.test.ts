import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The claims ADR-0007 and ADR-0008 make about the image that nothing else keeps.
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

/**
 * The `gh` the image carries.
 *
 * A second copy for the same mechanical reason as the one above — editing the
 * Dockerfile alone turns the run red — and for a *different* reason of its own,
 * which is worth writing down because the two pins look identical and are not.
 * Claude Code is pinned because every capture in this repository is evidence
 * about one build of it, so moving that number is a re-verification event that
 * costs Shared Window money. `gh`'s version invalidates no measurement. It is
 * pinned so that a rebuild cannot move it with nobody deciding to, and that is
 * the whole of it — which is also why it gets no drift notification and Claude
 * Code does.
 */
const GH_VERSION = '2.96.0'

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

describe('the image carries its own gh, pinned exactly', () => {
  it('installs the version the image says it does', () => {
    const pinned = GH_VERSION.replaceAll('.', String.raw`\.`)
    expect(dockerfile()).toMatch(new RegExp(`^ARG GH_VERSION=${pinned}$`, 'm'))
  })

  // A checksum that is a literal in the file, rather than one fetched alongside
  // the tarball — which would only detect corruption, since whoever could
  // replace the download could replace the checksum next to it.
  it('checks the tarball against a checksum of its own', () => {
    expect(dockerfile()).toMatch(/^ARG GH_SHA256=[0-9a-f]{64}$/m)
    expect(dockerfile()).toMatch(/sha256sum --check/)
  })

  // Not a third-party apt source, which floats the version across rebuilds with
  // nobody deciding to. The release tarball is the only form of `gh` whose
  // contents a checksum can pin.
  it('takes it from the pinned release rather than from a package feed', () => {
    expect(dockerfile()).toMatch(
      /releases\/download\/v\$\{GH_VERSION\}\/gh_\$\{GH_VERSION\}_linux_amd64\.tar\.gz/,
    )
    expect(dockerfile()).not.toMatch(/apt-get install[^\n]*\bgh\b/)
  })

  // The Credential Shim is what an agent reaches when it types `gh`, and the
  // real binary is somewhere PATH does not go. Otherwise the tool that cannot
  // take a credential helper would run with whatever token happened to be in the
  // environment, which is the arrangement ADR-0008 exists to avoid.
  it('puts the Shim under the name gh, and the real binary off PATH', () => {
    expect(dockerfile()).toMatch(/gh-shim\.js[^\n]*> \/usr\/local\/bin\/gh/)
    expect(dockerfile()).toMatch(/--directory \/usr\/local\/lib\/roma/)
  })
})

/**
 * ADR-0015's claims about the image, which are mostly claims about what is *not*
 * in it.
 *
 * The Cloud Shortcut is three lines of shell and no new bytes, and the whole
 * decision is that it stays that way: 439 MiB of cloud CLI buys convenience and
 * no capability, on a public registry, for every deployment that never touches a
 * cloud. §1 named its own reversal trigger, so this is what makes reversing it
 * a decision rather than a commit.
 */
describe('the image carries a Cloud Shortcut and no cloud CLI', () => {
  // Installed on every image, including the deployments with no Cloud Reach.
  // Omitted it would be `command not found`, which a model reads as a broken
  // PATH and spends a Turn investigating — the Turn the Shortcut exists to save.
  it('puts the Shortcut on PATH, under a name of roma’s own', () => {
    expect(dockerfile()).toMatch(/cloud-token\.js[^\n]*> \/usr\/local\/bin\/roma-cloud-token/)
  })

  // No `gcloud`, no `aws`, no `az`, and no second image tag to put one in. Not
  // by apt, not by tarball, not at boot — a container whose contents depend on
  // what a package index served that morning is not a pinned artifact.
  it('installs no cloud CLI, by any route', () => {
    expect(dockerfile()).not.toMatch(/\bgcloud\b/)
    expect(dockerfile()).not.toMatch(/google-cloud-(cli|sdk)/)
    expect(dockerfile()).not.toMatch(/\bawscli\b/)
    expect(dockerfile()).not.toMatch(/\bazure-cli\b/)
  })
})

describe('the image defaults the one path whose loss is by design', () => {
  it('names a work root, the one a weekly reclaim deletes on purpose', () => {
    expect(dockerfile()).toMatch(/^\s*ROMA_WORK_ROOT=\S+/m)
  })

  // The same rule as the work root, and for the same reason: what lives there is
  // a socket and a gitconfig, both recreated every boot and neither anybody's
  // data. Default what is lost by design; refuse what cannot be lost.
  it('names a Shim directory, which holds nothing that outlives a boot', () => {
    expect(dockerfile()).toMatch(/^\s*ROMA_SHIM_DIR=\S+/m)
  })

  // Not under the work root, which a weekly reclaim empties. A reclaimed socket
  // is every credential request in roma failing at once, with no explanation.
  it('keeps that directory out of the tree the reclaim walks', () => {
    const shimDir = /^\s*ROMA_SHIM_DIR=(\S+)/m.exec(dockerfile())?.[1] ?? ''
    const workRoot = /^\s*ROMA_WORK_ROOT=(\S+)/m.exec(dockerfile())?.[1] ?? ''

    expect(shimDir).not.toBe('')
    expect(shimDir.startsWith(workRoot)).toBe(false)
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

/**
 * The two lists that are a person's judgement about one Claude Code build.
 *
 * Neither can be checked by machine — nothing in the stream marks a command as
 * read-only, and Claude Code accepts model names roma has never heard of — so
 * both have to be re-audited by hand when the ADR-0007 pin moves. What is
 * asserted here is only that they will be *listed* when that happens:
 * `scripts/claude-code-drift.ts` greps the working tree for files naming the
 * pinned version and reports them under "What currently rests on 2.1.220", so a
 * file that names it is one the report already prints. Enumeration rather than
 * enforcement, which is what ADR-0012 recorded as open and ADR-0014 closed this
 * much of.
 */
describe('the lists that rest on the pin say so', () => {
  it.each([
    ['src/relays.ts', 'the Claude Code commands roma relays as themselves'],
    ['src/model-menu.ts', 'the models roma offers a Caller'],
  ])('%s names the version it was judged against', (file) => {
    expect(fromRepo(file)).toContain(CLAUDE_CODE_VERSION)
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
 * Everything CI executes: the workflows, and the whole of `scripts/`.
 *
 * `scripts/` is here because the workflows delegate to it, and a guard that
 * stopped at the YAML would be a fence with a gate in it — `docker run -e …`
 * inside a shell script spends money exactly as well as a workflow step does.
 *
 * The sweep is deliberately unfiltered rather than limited to what a workflow
 * names, so a script added and wired up later cannot arrive outside the guard.
 * The price is that it also reads files CI hands no work to, `*.test.ts` under
 * `scripts/` among them — so the SEAM_2 patterns below constrain the *prose* of
 * those tests as well as the commands of the real scripts. That is a live
 * constraint, not a hypothetical: `scripts/claude-code-drift.test.ts` passes
 * because it writes "seam 2" rather than `test:seam2`. Narrowing the filter would
 * buy that freedom back and reopen the gate, so the prose pays instead.
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

/** One file of this repository, whole — commentary included, which is the point. */
function fromRepo(path: string): string {
  return readFileSync(fromRoot(path), 'utf8')
}
