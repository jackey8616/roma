import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MINTER_SOCKET_VAR, SESSION_ID_VAR, socketPathIn } from '../shim-protocol.js'
import { ShimServer, type ShimLogRecord } from '../shim-server.js'
import { FakeMinter, fakeServedReaches } from '../../test/support/fake-minter.js'
import { gitConfig } from './shims.js'

const SESSION = 'a-session'
const REPOSITORY = 'a-team/roma.git'

let dirs: string[] = []
let servers: ShimServer[] = []

afterEach(async () => {
  for (const server of servers) await server.close()
  servers = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

async function pointGitAtRoma(minter = new FakeMinter()) {
  const dir = mkdtempSync(join(tmpdir(), 'roma-git-shim-'))
  dirs.push(dir)

  const log: ShimLogRecord[] = []
  const server = await ShimServer.listen({
    socketPath: socketPathIn(dir),
    reaches: fakeServedReaches({ minter }),
    taskFor: () => 'the-task',
    log: (record) => log.push(record),
  })
  servers.push(server)

  const configPath = join(dir, 'gitconfig')
  writeFileSync(configPath, gitConfig())

  return {
    minter,
    log,
    git: (operation: string, input: string) =>
      runGit(operation, input, {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: configPath,
        [MINTER_SOCKET_VAR]: server.socketPath,
        [SESSION_ID_VAR]: SESSION,
      }),
  }
}

describe('a real git, asking a real Credential Shim', () => {
  it('is answered with a credential it accepts', async () => {
    const roma = await pointGitAtRoma()

    const filled = await roma.git('fill', `url=https://github.com/${REPOSITORY}\n\n`)

    expect(filled.stdout).toContain('username=x-access-token')
    expect(filled.stdout).toContain('password=token-1')
    expect(filled.code).toBe(0)
  })

  it('is told which repository the credential is for', async () => {
    const roma = await pointGitAtRoma()

    await roma.git('fill', `url=https://github.com/${REPOSITORY}\n\n`)

    expect(roma.log).toContainEqual({
      event: 'credential',
      sessionId: SESSION,
      taskId: 'the-task',
      path: REPOSITORY,
      credential: 'code',
    })
  })

  it('hands a rejected credential back, and roma stops serving it', async () => {
    const roma = await pointGitAtRoma()
    const first = await roma.git('fill', `url=https://github.com/${REPOSITORY}\n\n`)
    expect(first.stdout).toContain('password=token-1')

    await roma.git(
      'reject',
      `protocol=https\nhost=github.com\npath=${REPOSITORY}\n` +
        'username=x-access-token\npassword=token-1\n\n',
    )
    const second = await roma.git('fill', `url=https://github.com/${REPOSITORY}\n\n`)

    expect(second.stdout).toContain('password=token-2')
    expect(roma.log).toContainEqual(
      expect.objectContaining({ event: 'credential-rejected', sessionId: SESSION }),
    )
  })

  it('leaves git with no credential when roma cannot mint one', async () => {
    const minter = new FakeMinter()
    minter.failsWith = new Error('the App private key was rejected')
    const roma = await pointGitAtRoma(minter)

    const filled = await roma.git('fill', `url=https://github.com/${REPOSITORY}\n\n`)

    expect(filled.stdout).not.toContain('password=')
    expect(roma.log).toContainEqual(
      expect.objectContaining({
        event: 'credential-failed',
        reason: 'the App private key was rejected',
      }),
    )
  })

  it('says why on stderr, where git cannot read it as a credential [fence:github-complaint-goes-to-stderr]', async () => {
    const why =
      "The Shim's complaint goes to stderr, never stdout and never nowhere (ADR-0008). git " +
      "parses the helper's stdout as `key=value` credential fields, so a sentence there is " +
      'read as one; swallowed, git says only that authentication failed and nobody can tell ' +
      'why (#62).'
    const minter = new FakeMinter()
    minter.failsWith = new Error('the App private key was rejected')
    const roma = await pointGitAtRoma(minter)

    const filled = await roma.git('fill', `url=https://github.com/${REPOSITORY}\n\n`)

    expect(filled.stderr, why).toContain('the App private key was rejected')
    expect(filled.stderr, why).not.toContain('invalid credential line')
  })
})

async function runGit(
  operation: string,
  input: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((finished, failed) => {
    const git = spawn('git', ['credential', operation], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    git.stdout.setEncoding('utf8')
    git.stderr.setEncoding('utf8')
    git.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    git.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    git.on('error', failed)
    git.on('close', (code) => finished({ stdout, stderr, code }))
    git.stdin.end(input)
  })
}
