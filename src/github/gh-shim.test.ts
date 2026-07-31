import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FreshTokens } from '../fresh-tokens.js'
import { MINTER_SOCKET_VAR, SESSION_ID_VAR, socketPathIn } from '../shim-protocol.js'
import { ShimServer } from '../shim-server.js'
import { FakeMinter } from '../../test/support/fake-minter.js'

/**
 * The `gh` Shim, against a stub that reports the environment it was started
 * with.
 *
 * A stub rather than the real `gh`, because the repository currently requires
 * only Claude Code on `PATH` and this slice should not add to that — a developer
 * should not have to install a second CLI to run `npm test`. What is being
 * asserted is roma's half of the contract and nothing of GitHub's: that a token
 * is minted per invocation, that it reaches exactly one child process, that
 * arguments and the exit code go straight through, and that a stale token
 * inherited from somewhere else never survives.
 *
 * That `gh` itself authenticates with an Installation Token is not asserted here
 * and cannot be. It is in `docs/github-app-verification.md`, unverified and said
 * so.
 */

const SHIM = fileURLToPath(new URL('./gh-shim.ts', import.meta.url))
const SESSION = 'a-session'

let dirs: string[] = []
let servers: ShimServer[] = []

afterEach(async () => {
  for (const server of servers) await server.close()
  servers = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

async function shimInFrontOf(stub: string, minter = new FakeMinter()) {
  const dir = mkdtempSync(join(tmpdir(), 'roma-gh-shim-'))
  dirs.push(dir)

  const server = await ShimServer.listen({
    socketPath: socketPathIn(dir),
    tokens: new FreshTokens({ minter }),
    taskFor: () => null,
    log: () => {},
  })
  servers.push(server)

  const ghPath = join(dir, 'gh-stub')
  writeFileSync(ghPath, stub)
  chmodSync(ghPath, 0o755)

  return {
    minter,
    run: (argv: readonly string[], extra: Record<string, string> = {}) =>
      runShim(argv, {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: dir,
        ROMA_GH_BIN: ghPath,
        [MINTER_SOCKET_VAR]: server.socketPath,
        [SESSION_ID_VAR]: SESSION,
        ...extra,
      }),
  }
}

/** A `gh` that says what it was given, and nothing else. */
const REPORTS_ITSELF = `#!/bin/sh
echo "GH_TOKEN=\${GH_TOKEN-<unset>}"
echo "args=$*"
exit 0
`

describe('the gh Shim', () => {
  it('gives the real gh a freshly minted token, and passes its arguments through', async () => {
    const gh = await shimInFrontOf(REPORTS_ITSELF)

    const ran = await gh.run(['pr', 'create', '--title', 'a fix'])

    expect(ran.stdout).toContain('GH_TOKEN=token-1')
    expect(ran.stdout).toContain('args=pr create --title a fix')
  })

  // Per invocation rather than per Session, which is the arithmetic the whole
  // design turns on: an environment fixed at Session spawn is stale within the
  // hour, and a Resident Session outliving an hour is ordinary. Two invocations
  // therefore ask twice — that they get the same string is the cache's doing,
  // and the cache is what decides when the string changes.
  it('asks for a credential on every invocation', async () => {
    const gh = await shimInFrontOf(REPORTS_ITSELF)

    await gh.run(['issue', 'list'])
    await gh.run(['issue', 'list'])

    const asked = await gh.run(['issue', 'list'])
    expect(asked.stdout).toContain('GH_TOKEN=token-1')
    // One mint behind three invocations: roma mints rarely, and the Shim's
    // asking often is what keeps the answer fresh rather than what costs.
    expect(gh.minter.minted).toHaveLength(1)
  })

  // A credential nobody chose is worse than none. `gh` reads `GH_TOKEN` and
  // `GITHUB_TOKEN`, and either could arrive from anywhere — so both are cleared
  // before anything else happens, and put back only with what roma minted.
  it('never lets a token from somewhere else through', async () => {
    const minter = new FakeMinter()
    minter.failsWith = new Error('the App is unreachable')
    const gh = await shimInFrontOf(REPORTS_ITSELF, minter)

    const ran = await gh.run(['issue', 'list'], { GH_TOKEN: 'somebody-elses-token' })

    expect(ran.stdout).toContain('GH_TOKEN=<unset>')
    // The tool still runs, and fails in its own words about the command that was
    // actually attempted. roma's reason is on stderr for the agent to relay.
    expect(ran.stderr).toContain('the App is unreachable')
  })

  it('exits with whatever the real gh exited with', async () => {
    const gh = await shimInFrontOf('#!/bin/sh\nexit 42\n')

    expect((await gh.run(['api', 'nonsense'])).code).toBe(42)
  })
})

async function runShim(
  argv: readonly string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((finished, failed) => {
    const shim = spawn(process.execPath, ['--import', 'tsx', SHIM, ...argv], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    shim.stdout.setEncoding('utf8')
    shim.stderr.setEncoding('utf8')
    shim.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    shim.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    shim.on('error', failed)
    shim.on('close', (code) => finished({ stdout, stderr, code }))
  })
}
