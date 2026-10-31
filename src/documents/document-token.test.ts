import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MINTER_SOCKET_VAR, SESSION_ID_VAR, socketPathIn } from '../shim-protocol.js'
import { ShimServer } from '../shim-server.js'
import { FakeDocumentMinter, fakeServedReaches } from '../../test/support/fake-minter.js'

const SHORTCUT = fileURLToPath(new URL('./document-token.ts', import.meta.url))
const SESSION = 'a-session'

let dirs: string[] = []
let servers: ShimServer[] = []

afterEach(async () => {
  for (const server of servers) await server.close()
  servers = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

async function shortcutAgainst({ documentMinter }: { documentMinter?: FakeDocumentMinter } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roma-document-token-'))
  dirs.push(dir)

  const server = await ShimServer.listen({
    socketPath: socketPathIn(dir),
    reaches: fakeServedReaches({ documentMinter: documentMinter ?? null }),
    taskFor: () => null,
    log: () => {},
  })
  servers.push(server)

  return {
    run: (argv: readonly string[] = [], extra: Record<string, string> = {}) =>
      runShortcut(argv, {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: dir,
        [MINTER_SOCKET_VAR]: server.socketPath,
        [SESSION_ID_VAR]: SESSION,
        ...extra,
      }),
  }
}

describe('the Document Shortcut', () => {
  it('prints the token and nothing else', async () => {
    const shortcut = await shortcutAgainst({ documentMinter: new FakeDocumentMinter() })

    const ran = await shortcut.run()

    expect(ran.stdout).toBe('document-token-1\n')
    expect(ran.stderr).toBe('')
    expect(ran.code).toBe(0)
  })

  it('gives the token, its expiry and the account under --json', async () => {
    const documentMinter = new FakeDocumentMinter()
    const shortcut = await shortcutAgainst({ documentMinter })

    const ran = await shortcut.run(['--json'])

    expect(JSON.parse(ran.stdout)).toEqual({
      token: 'document-token-1',
      expiresAt: new Date(documentMinter.minted[0]?.expiresAt ?? 0).toISOString(),
      account: documentMinter.account,
    })
    expect(ran.code).toBe(0)
  })

  it('says this deployment has no Document Reach, and exits non-zero', async () => {
    const shortcut = await shortcutAgainst()

    const ran = await shortcut.run()

    expect(ran.stdout).toBe('')
    expect(ran.stderr).toContain('no Document Reach')
    expect(ran.stderr).not.toContain('    at ')
    expect(ran.code).not.toBe(0)
  })

  it('passes on why there is no token, when there should have been one', async () => {
    const documentMinter = new FakeDocumentMinter()
    documentMinter.failsWith = new Error('the service account key was revoked')
    const shortcut = await shortcutAgainst({ documentMinter })

    const ran = await shortcut.run()

    expect(ran.stderr).toContain('revoked')
    expect(ran.code).not.toBe(0)
  })

  it('refuses an argument it does not take rather than ignoring it', async () => {
    const shortcut = await shortcutAgainst({ documentMinter: new FakeDocumentMinter() })

    const ran = await shortcut.run(['--jsno'])

    expect(ran.stdout).toBe('')
    expect(ran.stderr).toContain('--jsno')
    expect(ran.code).not.toBe(0)
  })

  it('says which variable is missing when there is no roma to ask', async () => {
    const shortcut = await shortcutAgainst({ documentMinter: new FakeDocumentMinter() })

    const ran = await shortcut.run([], { [MINTER_SOCKET_VAR]: '' })

    expect(ran.stderr).toContain(MINTER_SOCKET_VAR)
    expect(ran.code).not.toBe(0)
  })
})

async function runShortcut(
  argv: readonly string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((finished, failed) => {
    const child = spawn(process.execPath, ['--import', 'tsx', SHORTCUT, ...argv], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', failed)
    child.on('close', (code) => finished({ stdout, stderr, code }))
  })
}
