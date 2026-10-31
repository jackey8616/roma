import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MINTER_SOCKET_VAR, SESSION_ID_VAR, socketPathIn } from '../shim-protocol.js'
import { ShimServer } from '../shim-server.js'
import { FakeMinter, fakeServedReaches } from '../../test/support/fake-minter.js'

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
    reaches: fakeServedReaches({ minter }),
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

const REPORTS_ITSELF = `#!/bin/sh
echo "GH_TOKEN=\${GH_TOKEN-<unset>}"
echo "GITHUB_TOKEN=\${GITHUB_TOKEN-<unset>}"
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

  it('asks for a credential on every invocation', async () => {
    const gh = await shimInFrontOf(REPORTS_ITSELF)

    await gh.run(['issue', 'list'])
    await gh.run(['issue', 'list'])

    const asked = await gh.run(['issue', 'list'])
    expect(asked.stdout).toContain('GH_TOKEN=token-1')
    expect(gh.minter.minted).toHaveLength(1)
  })

  it('never lets a token from somewhere else through [fence:github-gh-runs-on-no-inherited-token]', async () => {
    const why =
      'The gh Shim clears every inherited `GH_TOKEN` and `GITHUB_TOKEN` before it mints, ' +
      'whichever way the mint goes (ADR-0008: the agent acts as the App, on a token roma ' +
      'minted). Left in place, when roma cannot mint `gh` runs silently on a stale credential ' +
      'nobody chose (#62).'
    const minter = new FakeMinter()
    minter.failsWith = new Error('the App is unreachable')
    const gh = await shimInFrontOf(REPORTS_ITSELF, minter)

    const ran = await gh.run(['issue', 'list'], {
      GH_TOKEN: 'somebody-elses-token',
      GITHUB_TOKEN: 'another-stale-token',
    })

    expect(ran.stdout, why).toContain('GH_TOKEN=<unset>')
    expect(ran.stdout, why).toContain('GITHUB_TOKEN=<unset>')
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
