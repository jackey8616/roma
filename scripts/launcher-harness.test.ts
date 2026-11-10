import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const dockerfile = () =>
  read('../Dockerfile')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
const harness = () => read('launcher-harness.sh')
const verifyImage = () => read('verify-image.sh')

const asksAbout = (checks: readonly string[], why: string) => {
  it('is asked of the built image, every line required to pass', () => {
    expect(verifyImage(), why).toContain('launcher-harness.sh')
    expect(verifyImage(), why).toContain("'failures 0'")
  })

  it.each(checks)('asks %s', (name) => {
    expect(harness(), why).toMatch(new RegExp(`^check ${name} '`, 'm'))
  })
}

describe('the image installs the Launcher for roma alone [fence:image-launcher-is-setuid-for-node-only]', () => {
  const why =
    'ADR-0036: the Launcher is setuid root and executable by group node only. No Seat is in ' +
    'that group, so the kernel refuses it to every agent. A wider mode hands root’s one ' +
    'program to the agent; a narrower one is a roma that cannot spawn.'

  it('copies it root:node, 4750', () => {
    expect(dockerfile(), why).toMatch(
      /^COPY --from=launcher --chown=root:node --chmod=4750 \/out\/roma-launch \/usr\/local\/libexec\/roma-launch$/m,
    )
  })

  it('makes sixteen Seats from uid 20000, each with a group of its own', () => {
    expect(dockerfile(), why).toContain('for i in $(seq 0 15)')
    expect(dockerfile(), why).toContain('id=$((20000 + i))')
    expect(dockerfile(), why).toContain('useradd --uid "${id}" --gid "${id}"')
  })

  it('makes the uid a parked Session belongs to, which nothing runs as', () => {
    expect(dockerfile(), why).toMatch(
      /useradd --uid 19999 --gid 19999 .*\n?.*--shell \/usr\/sbin\/nologin roma-parked/,
    )
  })

  it('compiles it with every warning an error', () => {
    expect(dockerfile(), why).toContain('-Werror')
  })
})

describe('the Launcher refuses anyone but roma [fence:launcher-refuses-anyone-but-roma]', () => {
  asksAbout(
    [
      'refuses-root',
      'refuses-a-seat',
      'refuses-a-bad-seat',
      'refuses-a-bad-session',
      'refuses-writable-roots',
      'enclose-refuses-another-seats',
      'enclose-refuses-a-path-name',
      'enclose-follows-no-symlink',
      'symlink-target-untouched',
      'runs-with-no-new-privs',
    ],
    'ADR-0036: the Launcher is the only root after boot. It must refuse every caller but ' +
      'roma, take no path from its caller, follow no link in a Session’s tree, and leave the ' +
      'Runtime unable to climb back through another setuid program.',
  )
})

describe('a Seat is emptied before anyone holds it again [fence:seat-is-emptied-before-reuse]', () => {
  asksAbout(
    [
      'orphan-is-killed',
      'seat-is-empty',
      'shared-tmp-is-purged',
      'work-is-parked',
      'transcript-is-parked',
      'reused-seat-reads-no-work',
      'reused-seat-lists-no-work',
      'reused-seat-reads-no-transcript',
      'reused-seat-writes-no-transcript',
      'resumed-session-reads-its-own',
      'sessions-is-made-passable',
    ],
    'ADR-0036: Seats are reused, so a Seat returned with a process still running, a file left ' +
      'in /tmp or a Session not parked hands one Session’s data to the next holder of the uid.',
  )
})

describe('the image is proved on exactly the capabilities the README names [fence:image-proved-on-the-documented-caps]', () => {
  const why =
    'ADR-0036: an Operator who runs --cap-drop=ALL adds back what the README lists, and ' +
    'nothing else. Proved only on Docker’s default set, a list one short — DAC_OVERRIDE, which ' +
    'the Launcher needs to open node’s 0711 roots as root — passes here and fails there.'
  const capsIn = (text: string): string[] =>
    [...text.matchAll(/--cap-add=([A-Z_]+)/g)].map((match) => match[1] ?? '').sort()
  const minimumCaps = (): string => {
    const declared = /^minimum_caps=\(([^)]*)\)$/m.exec(verifyImage())
    if (declared?.[1] === undefined) throw new Error('verify-image.sh declares no minimum_caps')
    return declared[1]
  }

  it('drops every capability and adds back the README’s list', () => {
    expect(minimumCaps(), why).toContain('--cap-drop=ALL')
    expect(capsIn(minimumCaps()), why).toEqual(capsIn(read('../README.md')))
  })

  it('runs every harness that boots the image on that set', () => {
    const runs = verifyImage().match(/docker run [^\n]*"\$\{minimum_caps\[@\]\}"/g) ?? []
    expect(runs, why).toHaveLength(4)
  })
})
