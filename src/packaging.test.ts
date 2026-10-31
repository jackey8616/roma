import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CLAUDE_CODE_VERSION = '2.1.220'

const GH_VERSION = '2.96.0'

describe('the image carries its own Claude Code, pinned exactly', () => {
  it('installs the version every measurement in this repo was taken against', () => {
    const pinned = CLAUDE_CODE_VERSION.replaceAll('.', String.raw`\.`)
    expect(dockerfile()).toMatch(new RegExp(`^ARG CLAUDE_CODE_VERSION=${pinned}$`, 'm'))
  })

  it('installs that version rather than whatever npm would resolve today', () => {
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

  it('checks the tarball against a checksum of its own', () => {
    expect(dockerfile()).toMatch(/^ARG GH_SHA256=[0-9a-f]{64}$/m)
    expect(dockerfile()).toMatch(/sha256sum --check/)
  })

  it('takes it from the pinned release rather than from a package feed', () => {
    expect(dockerfile()).toMatch(
      /releases\/download\/v\$\{GH_VERSION\}\/gh_\$\{GH_VERSION\}_linux_amd64\.tar\.gz/,
    )
    expect(dockerfile()).not.toMatch(/apt-get install[^\n]*\bgh\b/)
  })

  it('puts the Shim under the name gh, and the real binary off PATH', () => {
    expect(dockerfile()).toMatch(/gh-shim\.js[^\n]*> \/usr\/local\/bin\/gh/)
    expect(dockerfile()).toMatch(/--directory \/usr\/local\/lib\/roma/)
  })
})

describe('the image carries a Cloud Shortcut and no cloud CLI', () => {
  it('puts the Shortcut on PATH, under a name of roma’s own', () => {
    expect(dockerfile()).toMatch(/cloud-token\.js[^\n]*> \/usr\/local\/bin\/roma-cloud-token/)
  })

  it('installs no cloud CLI, by any route', () => {
    expect(dockerfile()).not.toMatch(/\bgcloud\b/)
    expect(dockerfile()).not.toMatch(/google-cloud-(cli|sdk)/)
    expect(dockerfile()).not.toMatch(/\bawscli\b/)
    expect(dockerfile()).not.toMatch(/\bazure-cli\b/)
  })
})

describe('the image carries a Document Shortcut', () => {
  it('puts the Shortcut on PATH, under a name of roma’s own', () => {
    expect(dockerfile()).toMatch(/document-token\.js[^\n]*> \/usr\/local\/bin\/roma-document-token/)
  })
})

describe('the image defaults the one path whose loss is by design', () => {
  it('names a work root, the one a weekly reclaim deletes on purpose', () => {
    expect(dockerfile()).toMatch(/^\s*ROMA_WORK_ROOT=\S+/m)
  })

  it('names a Shim directory, which holds nothing that outlives a boot', () => {
    expect(dockerfile()).toMatch(/^\s*ROMA_SHIM_DIR=\S+/m)
  })

  it('keeps that directory out of the tree the reclaim walks', () => {
    const shimDir = /^\s*ROMA_SHIM_DIR=(\S+)/m.exec(dockerfile())?.[1] ?? ''
    const workRoot = /^\s*ROMA_WORK_ROOT=(\S+)/m.exec(dockerfile())?.[1] ?? ''

    expect(shimDir).not.toBe('')
    expect(shimDir.startsWith(workRoot)).toBe(false)
  })

  it('sets no audit root and no Claude config dir — losing either is data loss [fence:image-no-default-for-data]', () => {
    const why =
      'The image must default neither ROMA_AUDIT_ROOT nor ROMA_CLAUDE_CONFIG_DIR (ADR-0006, ' +
      'ADR-0007; #54). readRomaEnv refuses to start without either on purpose; a default puts ' +
      'that data in the container’s writable layer, where it vanishes with every container ' +
      'replacement — the Audit Records, the only place per-user attribution exists (ADR-0002), ' +
      'or the Transcript, the only account of what an agent did (ADR-0005).'
    expect(dockerfile(), why).not.toMatch(/ROMA_AUDIT_ROOT[\s=]/)
    expect(dockerfile(), why).not.toMatch(/ROMA_CLAUDE_CONFIG_DIR[\s=]/)
  })

  it.each(['/var/lib/roma/audit', '/var/lib/roma/claude'])(
    'makes %s and gives it to node [fence:volume-paths-owned-by-node]',
    (path) => {
      const why =
        `The image must mkdir ${path} and chown it to node:node (ADR-0007, "stays silent ` +
        'on the two that are data"). Docker materialises an empty named volume over a path ' +
        'the image never created as root:root, and roma runs as node, so the first Audit ' +
        'Record or Transcript is lost to EACCES once the volume clears the startup refusal (#54).'
      const runs = instructions().filter((line) => line.startsWith('RUN '))
      const made = runs.find((run) => words(run, 'mkdir').includes(path))

      expect(made, why).toBeDefined()
      const owners = words(made ?? '', 'chown').filter((w) => !w.startsWith('-'))
      expect(owners[0], why).toBe('node:node')
      expect(
        owners.slice(1).some((owned) => path === owned || path.startsWith(`${owned}/`)),
        why,
      ).toBe(true)
    },
  )
})

describe('the image keeps out of what Claude Code reads [fence:image-adds-no-skills-or-volumes]', () => {
  it('declares no VOLUME', () => {
    const why =
      'The image must not declare a VOLUME (ADR-0007, "VOLUME /var/lib/roma/claude instead ' +
      'of the refusal", rejected). It makes an anonymous volume, which `docker run --rm` ' +
      'removes on exit: the Transcript is lost while the Dockerfile reads as protecting it.'

    expect(
      instructions().filter((line) => /^VOLUME\b/i.test(line)),
      why,
    ).toEqual([])
  })

  it('writes nothing under a .claude directory', () => {
    const why =
      'No instruction may write a .claude path (ADR-0030). Claude Code resolves project ' +
      'skills under every ancestor of the Working Directory up to /, and roma never git ' +
      'inits one, so a skill the image puts in /var/lib/roma/work, /var/lib/roma, /var/lib, ' +
      '/var or / is read into every Session.'

    expect(
      instructions().filter(
        (line) => /^(COPY|ADD|RUN|WORKDIR)\b/i.test(line) && /\.claude\b/.test(line),
      ),
      why,
    ).toEqual([])
  })
})

describe('src/ is TypeScript and nothing else [fence:src-ships-only-typescript]', () => {
  it('holds no file tsc would not compile into dist/', () => {
    const why =
      'Every file under src/ must be .ts (ADR-0030, "The ruleset is a TypeScript constant"). ' +
      '`build` is `rm -rf dist && tsc` and the image copies dist/ alone, so a .md or .json ' +
      'under src/ is silently missing from the image while every test that reads it passes.'

    expect(
      filesIn('src', (file) => !file.endsWith('.ts')).map(({ file }) => file),
      why,
    ).toEqual([])
  })
})

function instructions(): string[] {
  return dockerfile()
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
}

function words(run: string, command: string): string[] {
  return run
    .split('&&')
    .map((step) =>
      step
        .trim()
        .replace(/^RUN\s+/, '')
        .split(/\s+/),
    )
    .filter(([head]) => head === command)
    .flatMap(([, ...rest]) => rest)
}

describe('the lists that rest on the pin say so [fence:pin-lists-name-the-version]', () => {
  it.each([
    ['src/relays.ts', 'the Claude Code commands roma relays as themselves'],
    ['src/model-menu.ts', 'the models roma offers a Caller'],
  ])('%s names the version it was judged against', (file, what) => {
    const why =
      `${file} holds ${what}, a judgement about one Claude Code build, and must name the pinned ` +
      'version (ADR-0012, ADR-0014). The drift check lists every file naming the pin when it ' +
      'moves; a list that does not name it is left out of that report, and nobody is told to ' +
      're-audit it before it starts relaying something that disturbs a belief roma holds.'
    expect(fromRepo(file), why).toContain(CLAUDE_CODE_VERSION)
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

const SEAM_2 = [/\btest:seam2\b/, /\.live\.test\b/, /\bCLAUDE_CODE_OAUTH_TOKEN\b/]

function dockerfile(): string {
  return withoutComments(readFileSync(fromRoot('Dockerfile'), 'utf8'))
}

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
  return readdirSync(path, { recursive: true, encoding: 'utf8' })
    .filter((file) => statSync(join(path, file)).isFile() && wanted(file))
    .map((file) => ({
      file: `${directory}/${file}`,
      source: readFileSync(join(path, file), 'utf8'),
    }))
}

function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

function fromRoot(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url))
}

function fromRepo(path: string): string {
  return readFileSync(fromRoot(path), 'utf8')
}
