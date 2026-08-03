import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MINTER_SOCKET_VAR, SESSION_ID_VAR, socketPathIn } from '../shim-protocol.js'
import { ShimServer } from '../shim-server.js'
import { FakeDocumentMinter, fakeServedReaches } from '../../test/support/fake-minter.js'

/**
 * The Document Shortcut as a shell sees it: a real child process, a real socket.
 *
 * Spawned rather than called, mirroring `src/cloud/cloud-token.test.ts` and
 * `src/github/gh-shim.test.ts`, and justified the same way: the Shortcut's
 * entire contract is what a shell observes. Exactly what lands on stdout,
 * exactly what does not, the exit code, and which stream the refusal goes to are
 * the whole of the thing — and nothing in-process can see any of it.
 *
 * The bare form's contract in particular is unusually literal, because the
 * command exists to be substituted:
 * `curl -H "Authorization: Bearer $(roma-document-token)"`. One stray character
 * on stdout is a malformed Authorization header and an unexplained 401 inside
 * somebody's Turn.
 *
 * Nothing here touches Drive, and the token it prints comes from a fake Minter —
 * so unlike its neighbours this file makes no claim about Google at all. What it
 * asserts is the contract between roma and a shell, which is entirely roma's and
 * is the one thing in this directory that could have been measured and was.
 */

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

async function shortcutAgainst({
  documentMinter,
}: { documentMinter?: FakeDocumentMinter } = {}) {
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
  // Nothing to parse, because a tool invented to save the model's output tokens
  // should not require the model to write a parser to use it. The trailing
  // newline is what every command writes and what `$(…)` strips.
  it('prints the token and nothing else', async () => {
    const shortcut = await shortcutAgainst({ documentMinter: new FakeDocumentMinter() })

    const ran = await shortcut.run()

    expect(ran.stdout).toBe('document-token-1\n')
    expect(ran.stderr).toBe('')
    expect(ran.code).toBe(0)
  })

  // The expiry is behind `--json` rather than in the default because re-running
  // is free and stateless: an agent does not need to reason about how long it
  // has left, it needs to ask again. What `--json` is for is the APIs that want
  // the identity named.
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

  // Story 18, and the reason the program is on every image: omitted it would be
  // `command not found`, which a model reads as a broken PATH and spends a Turn
  // investigating. One sentence, on stderr, repeatable to a person, and nothing
  // on stdout for a caller to mistake for a credential.
  it('says this deployment has no Document Reach, and exits non-zero', async () => {
    const shortcut = await shortcutAgainst()

    const ran = await shortcut.run()

    expect(ran.stdout).toBe('')
    expect(ran.stderr).toContain('no Document Reach')
    expect(ran.stderr).not.toContain('    at ')
    expect(ran.code).not.toBe(0)
  })

  // roma's own sentence rather than a paraphrase: "this deployment has none" and
  // "the key stopped working" are different problems for different people, and
  // the agent has to be able to relay either.
  it('passes on why there is no token, when there should have been one', async () => {
    const documentMinter = new FakeDocumentMinter()
    documentMinter.failsWith = new Error('the service account key was revoked')
    const shortcut = await shortcutAgainst({ documentMinter })

    const ran = await shortcut.run()

    expect(ran.stderr).toContain('revoked')
    expect(ran.code).not.toBe(0)
  })

  // A silently ignored `--jsno` hands a bare token to something that was about
  // to parse it, and the failure surfaces as unreadable JSON several steps from
  // the typo that caused it.
  it('refuses an argument it does not take rather than ignoring it', async () => {
    const shortcut = await shortcutAgainst({ documentMinter: new FakeDocumentMinter() })

    const ran = await shortcut.run(['--jsno'])

    expect(ran.stdout).toBe('')
    expect(ran.stderr).toContain('--jsno')
    expect(ran.code).not.toBe(0)
  })

  // Running roma from source, or something invoking this by hand. The complaint
  // names the variable rather than reporting an unexplained connection failure,
  // which is what would send somebody to look at the socket instead.
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
