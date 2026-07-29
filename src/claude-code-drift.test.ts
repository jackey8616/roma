import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The notify-only drift check: `scripts/claude-code-drift.sh` and the workflow
 * that files what it writes.
 *
 * Two kinds of claim here, and they are checked two ways. The behavioural ones —
 * what the check does when the versions agree, when they do not, and when it
 * cannot find out — run the script for real against a throwaway repository with
 * a fake `npm` ahead of the real one on `PATH`, so the whole suite stays offline
 * and free. The repository-level ones are read out of the files, in the idiom
 * `src/packaging.test.ts` uses, because "this workflow opens no pull request" is
 * a claim about a file rather than about behaviour.
 *
 * The failure mode worth the effort is the check passing forever while watching
 * nothing. A 404, a reformatted `ARG`, a regex that stopped matching: every one
 * of them has a test here that fails the run, because a green tick on this
 * workflow reads as "the pin is current".
 */

const CHECK = fromRoot('scripts/claude-code-drift.sh')
const WORKFLOW = '.github/workflows/claude-code-drift.yml'

/**
 * The pinned version, read the way the check reads it.
 *
 * Deliberately not a literal. `src/packaging.test.ts` carries the second copy
 * that makes editing the Dockerfile alone turn red, and that pair is the whole
 * mechanism — a third copy here would be one more place to forget, in the one
 * file whose subject is a check that must not restate the pin either.
 */
const PINNED = /^ARG CLAUDE_CODE_VERSION=(.+)$/m.exec(
  readFileSync(fromRoot('Dockerfile'), 'utf8'),
)?.[1]

describe('the drift check is quiet only when the pin is the latest published version', () => {
  it('writes nothing and says nothing when the two agree', () => {
    const outcome = run({ npm: 'echo 9.9.9' })

    expect(outcome.status).toBe(0)
    expect(outcome.report).toBeNull()
    expect(outcome.stdout).toBe('')
  })

  it('reports drift as its own exit code, with the issue title on stdout', () => {
    const outcome = run()

    // 2 rather than 1, because `set -e` turns any unexpectedly failing command
    // into an exit 1 — and drift is the one verdict that must not be reachable
    // by accident.
    expect(outcome.status).toBe(2)
    expect(outcome.stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(outcome.stdout).toContain('9.9.9')
    expect(outcome.stdout).toContain('9.9.10')
  })
})

describe('the report makes the cost visible at the same moment as the availability', () => {
  const report = drifted()

  it('names the pinned version and the one that is now available', () => {
    expect(report).toContain('9.9.9')
    expect(report).toContain('9.9.10')
  })

  it('says that moving the pin means re-running seam 2 against the Shared Window', () => {
    expect(report).toMatch(/seam 2/)
    expect(report).toMatch(/Shared Window/)
  })

  it('lists the files that carry evidence about the pinned version', () => {
    expect(report).toContain('- `docs/measured.md`')
    expect(report).toContain('- `Dockerfile`')
  })

  it('generates that list rather than guessing at it', () => {
    // The file that does not mention the version is not on the list, which is
    // the only thing that distinguishes a generated list from a hardcoded one.
    expect(report).not.toContain('- `docs/about-something-else.md`')
  })

  it('says plainly that nothing is broken', () => {
    expect(report).toMatch(/nothing is broken/i)
  })

  it('carries a marker naming the version it reported', () => {
    // What lets a later run tell "this drift is still open" from "a human read
    // this one and closed it" without re-reading the prose.
    expect(report).toContain('<!-- claude-code-drift latest=9.9.10 -->')
  })
})

describe('every way the comparison can fail ends the run red', () => {
  it('fails when there is no Dockerfile to read the pin out of', () => {
    expect(run({ dockerfile: null }).status).toBe(1)
  })

  it('fails when the ARG is not there to parse', () => {
    expect(run({ dockerfile: 'FROM node:22-slim\n' }).status).toBe(1)
  })

  it('fails when the ARG holds something that is not an exact version', () => {
    expect(run({ dockerfile: 'ARG CLAUDE_CODE_VERSION=latest\n' }).status).toBe(1)
    expect(run({ dockerfile: 'ARG CLAUDE_CODE_VERSION=^9.9.9\n' }).status).toBe(1)
  })

  it('fails when the registry lookup fails', () => {
    expect(run({ npm: 'exit 1' }).status).toBe(1)
  })

  it('fails when the registry answers with something that is not a version', () => {
    expect(run({ npm: "echo 'npm error code E404'" }).status).toBe(1)
    expect(run({ npm: 'true' }).status).toBe(1)
  })

  it('fails when a version arrives with anything else attached to it', () => {
    // The shape this most plausibly takes: npm answers, correctly, but says
    // something first. Checked per-line, that passes — and then the warning is
    // what gets compared against the pin, written into the title and carried
    // into the marker, all as two lines.
    expect(run({ npm: `printf 'npm warn deprecated thing\\n9.9.10\\n'` }).status).toBe(1)
  })

  it('writes no report when it could not make the comparison', () => {
    expect(run({ npm: 'exit 1' }).report).toBeNull()
  })
})

describe('the drift check reports the pin and never moves it', () => {
  it('reads the pin from the Dockerfile rather than restating it', () => {
    expect(PINNED).toMatch(/^\d+\.\d+\.\d+/)

    for (const { file, source } of drift()) {
      expect(source, file).not.toContain(PINNED)
    }
  })

  it('opens an issue', () => {
    expect(workflow()).toContain('gh issue create')
    expect(workflow()).toContain('gh issue edit')
  })

  it('runs on a schedule, since nothing else would ever start it', () => {
    expect(workflow()).toMatch(/^\s+- cron: /m)
  })

  it('has nothing in it that could bump the pin or open a pull request', () => {
    // ADR-0006's reason, kept: a bump pull request would look like routine
    // maintenance while invalidating every measurement in `docs/`, and CI would
    // go green, because seam 2 does not run there.
    const forbidden = [
      /\bgh pr\b/,
      /create-pull-request/,
      /peter-evans/,
      /\bgit (?:add|commit|push)\b/,
      /\bsed -i\b/,
      />\s*Dockerfile\b/,
    ]

    const offenders = drift().filter(({ source }) =>
      forbidden.some((pattern) => pattern.test(source)),
    )

    expect(offenders.map(({ file }) => file)).toEqual([])
  })
})

interface Outcome {
  status: number | null
  stdout: string
  stderr: string
  report: string | null
}

/**
 * The check, run for real against a repository made for the occasion.
 *
 * `npm` is a script this test writes, ahead of the real one on `PATH`, so what
 * the registry says is an argument rather than a network call — which is what
 * keeps the default run offline, free and deterministic, and is the only way to
 * ask what happens when the lookup fails.
 */
function run({
  dockerfile = 'ARG CLAUDE_CODE_VERSION=9.9.9\n',
  files = {},
  npm = 'echo 9.9.10',
}: {
  dockerfile?: string | null
  files?: Record<string, string>
  npm?: string
} = {}): Outcome {
  const workspace = mkdtempSync(join(tmpdir(), 'roma-drift-'))

  const write = (path: string, contents: string): string => {
    const full = join(workspace, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
    return full
  }

  if (dockerfile !== null) write('Dockerfile', dockerfile)
  for (const [path, contents] of Object.entries(files)) write(path, contents)
  chmodSync(write('bin/npm', `#!/usr/bin/env bash\n${npm}\n`), 0o755)

  // A repository, because the check lists its evidence with `git grep` — which
  // is what keeps build output and `node_modules` off the list in the real one.
  execFileSync('git', ['init', '--quiet'], { cwd: workspace, stdio: 'ignore' })
  execFileSync('git', ['add', '--all'], { cwd: workspace, stdio: 'ignore' })

  const report = join(workspace, 'report.md')
  const { status, stdout, stderr } = spawnSync('bash', [CHECK, report], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(workspace, 'bin')}:${process.env.PATH ?? ''}` },
  })

  const outcome = {
    status,
    stdout,
    stderr,
    report: existsSync(report) ? readFileSync(report, 'utf8') : null,
  }

  // Read first, then gone. Every assertion here is against what came back, and
  // a suite that ran this often would otherwise leave a repository per case
  // behind in the temp directory.
  rmSync(workspace, { force: true, recursive: true })

  return outcome
}

/** One drifted report, against a repository whose evidence is known. */
function drifted(): string {
  return (
    run({
      files: {
        'docs/measured.md': 'Captured against 9.9.9.\n',
        'docs/about-something-else.md': 'No version in here.\n',
      },
    }).report ?? ''
  )
}

/**
 * The drift check as its two files, without their commentary.
 *
 * Both of them explain themselves by naming the exact thing they must not do —
 * bump the pin, open a pull request — so reading the prose as if it were an
 * instruction would make documenting the decision the way to break the test
 * that keeps it. `src/packaging.test.ts` strips comments for the same reason.
 */
function drift(): { file: string; source: string }[] {
  return [WORKFLOW, 'scripts/claude-code-drift.sh'].map((file) => ({
    file,
    source: readFileSync(fromRoot(file), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n'),
  }))
}

/** The workflow alone, for the claims that are only about it. */
function workflow(): string {
  const found = drift().find(({ file }) => file === WORKFLOW)
  if (!found) throw new Error(`${WORKFLOW} is not among the drift files`)
  return found.source
}

function fromRoot(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url))
}
