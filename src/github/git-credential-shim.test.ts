import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { InstallationTokens } from '../installation-tokens.js'
import { MINTER_SOCKET_VAR, SESSION_ID_VAR, socketPathIn } from '../shim-protocol.js'
import { ShimServer, type ShimLogRecord } from '../shim-server.js'
import { FakeMinter } from '../../test/support/fake-minter.js'
import { gitConfig, gitCredentialHelper } from './shims.js'

/**
 * The single most important test in this repository's GitHub work, and the one
 * ADR-0008 was most likely to be wrong about.
 *
 * A **real `git`** is pointed at a **real Credential Shim** talking to a **real
 * socket server**, and only the forge itself is a double. Everything the design
 * rests on is asserted here as behaviour rather than as intent: that `git`
 * invokes the Shim at all, that the answer is in a shape `git` accepts, that the
 * request carries the repository path, and that a rejected credential comes back
 * as `erase` and is discarded.
 *
 * It is in the **default run** deliberately. No network, no credential, no money
 * — `git credential fill` never touches GitHub — so there is nothing to make it
 * opt-in for, and the precedent is `scripts/` being brought into the free run on
 * the same reasoning: it widens what is covered without widening what can be
 * reached.
 *
 * **Nothing here is skipped.** A test that quietly passed when `git` is absent
 * would report green while the contract underneath all of this went unasserted,
 * which is the failure mode this repository already documents for seam 2. If
 * `git` is not installed, `spawn` fails and so does the test.
 */

/** The Shim, run from source. `--import tsx` is the only reason this is not just `node`. */
const SHIM = fileURLToPath(new URL('./git-credential-shim.ts', import.meta.url))
const NODE_RUNNING_TYPESCRIPT = `${process.execPath} --import tsx`

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
    tokens: new InstallationTokens({ minter }),
    taskFor: () => 'the-task',
    log: (record) => log.push(record),
  })
  servers.push(server)

  // The real gitconfig, from the real function, with only the path to the Shim
  // changed — which is the one thing about it that differs between a build and a
  // checkout.
  const configPath = join(dir, 'gitconfig')
  writeFileSync(configPath, gitConfig(gitCredentialHelper(SHIM, NODE_RUNNING_TYPESCRIPT)))

  return {
    minter,
    log,
    /** Run a real `git credential <operation>` against it. */
    git: (operation: string, input: string) =>
      runGit(operation, input, {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: dir,
        // So that a developer's own `~/.gitconfig` and the machine's system
        // config cannot decide what this test measures.
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

    // `git credential fill` prints the credential it settled on. That it prints
    // these two lines at all is the whole assertion: git ran the helper, read
    // its answer, and did not fall through to asking somebody.
    expect(filled.stdout).toContain('username=x-access-token')
    expect(filled.stdout).toContain('password=token-1')
    expect(filled.code).toBe(0)
  })

  // `credential.useHttpPath` is what makes this true, and it is set for exactly
  // this reason: it is what will let an Audit Record say which repositories a
  // Task reached for. Nothing is written down here — that is its own ticket —
  // but the request carrying the path is what keeps it possible.
  it('is told which repository the credential is for', async () => {
    const roma = await pointGitAtRoma()

    await roma.git('fill', `url=https://github.com/${REPOSITORY}\n\n`)

    expect(roma.log).toContainEqual({
      event: 'credential',
      sessionId: SESSION,
      taskId: 'the-task',
      path: REPOSITORY,
    })
  })

  // Measured on git 2.43.0 before any of this existed (ADR-0008's amendment): a
  // failed authentication calls the helper a second time with `erase`, handing
  // back the credential that was rejected. That is roma's only signal that a
  // token it believes in has stopped working.
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

    // A fresh token, not the dead one served for the rest of its hour.
    expect(second.stdout).toContain('password=token-2')
    expect(roma.log).toContainEqual(
      expect.objectContaining({ event: 'credential-rejected', sessionId: SESSION }),
    )
  })

  // The runtime failure that has no special handling by design: the Shim answers
  // with nothing, git says authentication failed in its own words, and the agent
  // reports that to the person in the context of what it was attempting.
  it('leaves git with no credential when roma cannot mint one', async () => {
    const minter = new FakeMinter()
    minter.failsWith = new Error('the App private key was rejected')
    const roma = await pointGitAtRoma(minter)

    const filled = await roma.git('fill', `url=https://github.com/${REPOSITORY}\n\n`)

    expect(filled.stdout).not.toContain('password=')
    // And the operator gets the one line that makes three people's Tasks failing
    // separately recognisable as one cause.
    expect(roma.log).toContainEqual(
      expect.objectContaining({
        event: 'credential-failed',
        reason: 'the App private key was rejected',
      }),
    )
  })
})

/** One `git credential …`, with stdin written and stdout collected. */
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
    // Never skipped: a missing `git` is a failing test, not a quiet pass.
    git.on('error', failed)
    git.on('close', (code) => finished({ stdout, stderr, code }))
    git.stdin.end(input)
  })
}
