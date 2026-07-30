import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstallationTokens } from './installation-tokens.js'
import { askMinter } from './shim-client.js'
import { socketPathIn } from './shim-protocol.js'
import { ShimServer, type ShimLogRecord } from './shim-server.js'
import { FakeMinter } from '../test/support/fake-minter.js'

/**
 * roma's side of the Credential Shim contract, over a real socket.
 *
 * A real Unix domain socket rather than a stubbed transport, because the socket
 * *is* the decision: a TCP port would be reachable by anything on the host, and
 * "one line in, one line out, then closed" is the protocol both Shims are
 * written against. There is nothing slow or unreachable about it — the two ends
 * are in the same process.
 */

const SESSION = 'a-session'

let dirs: string[] = []
let servers: ShimServer[] = []

afterEach(async () => {
  for (const server of servers) await server.close()
  servers = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

async function listening({
  minter = new FakeMinter(),
  taskFor = () => 'the-task' as string | null,
}: { minter?: FakeMinter; taskFor?: () => string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roma-shim-server-'))
  dirs.push(dir)
  const log: ShimLogRecord[] = []
  const server = await ShimServer.listen({
    socketPath: socketPathIn(dir),
    tokens: new InstallationTokens({ minter }),
    taskFor,
    log: (record) => log.push(record),
  })
  servers.push(server)
  return { server, minter, log, dir }
}

describe('answering a Credential Shim', () => {
  it('hands over an Installation Token', async () => {
    const { server } = await listening()

    const answer = await askMinter(server.socketPath, { session: SESSION, operation: 'get' })

    expect(answer.token).toBe('token-1')
  })

  it('drops a token it is told was rejected', async () => {
    const { server, minter } = await listening()
    const first = await askMinter(server.socketPath, { session: SESSION, operation: 'get' })

    await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'erase',
      token: first.token,
    })
    const second = await askMinter(server.socketPath, { session: SESSION, operation: 'get' })

    expect(second.token).toBe('token-2')
    expect(minter.minted).toHaveLength(2)
  })

  // Nothing special happens when minting fails, and that is the decision: an
  // Outbound Instruction named after a product would mean the Core knows about
  // GitHub, and a circuit breaker would turn a forge outage into a roma outage
  // for the majority of Tasks that touch no repository.
  it('answers with no credential and the reason when minting fails', async () => {
    const minter = new FakeMinter()
    minter.failsWith = new Error('the App private key was rejected')
    const { server } = await listening({ minter })

    const answer = await askMinter(server.socketPath, { session: SESSION, operation: 'get' })

    expect(answer.token).toBeNull()
    expect(answer.reason).toContain('private key')
  })

  // Anything in the agent's userland can write to this socket, including
  // programs the agent wrote itself. A cast would turn a malformed line into a
  // TypeError inside roma.
  it('survives something that is not a Shim talking to it', async () => {
    const { server, log } = await listening()

    const answer = await askMinter(server.socketPath, {
      session: '',
      operation: 'get',
    })

    expect(answer.token).toBeNull()
    expect(log).toContainEqual(expect.objectContaining({ event: 'shim-unreadable' }))
    // Still serving: one bad line is not the end of every credential in roma.
    expect(
      (await askMinter(server.socketPath, { session: SESSION, operation: 'get' })).token,
    ).toBe('token-1')
  })
})

describe('who a credential request belongs to', () => {
  it('names the Session, and the Task that Session is running', async () => {
    const { server, log } = await listening()

    await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'get',
      path: 'a-team/roma.git',
    })

    expect(log).toEqual([
      { event: 'credential', sessionId: SESSION, taskId: 'the-task', path: 'a-team/roma.git' },
    ])
  })

  // A background process the agent left running, or work that outlived its
  // Task. Recorded as belonging to no Task rather than to the nearest one: the
  // same rule the Audit Record applies when it writes a Turn down as unpriced
  // rather than as free.
  it('records a request that belongs to no running Task as belonging to none', async () => {
    const { server, log } = await listening({ taskFor: () => null })

    await askMinter(server.socketPath, { session: SESSION, operation: 'get' })

    expect(log).toEqual([
      { event: 'credential', sessionId: SESSION, taskId: null, path: null },
    ])
  })
})

describe('the socket itself', () => {
  // A container killed rather than stopped leaves the file behind, and `listen`
  // on an existing path fails with EADDRINUSE — which would present as roma
  // refusing to boot after every hard restart, for a file nothing is listening
  // on.
  it('is taken over from a boot that did not clean up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roma-shim-server-'))
    dirs.push(dir)
    // What a killed container leaves behind: the file, with nothing listening.
    writeFileSync(socketPathIn(dir), '')

    const server = await ShimServer.listen({
      socketPath: socketPathIn(dir),
      tokens: new InstallationTokens({ minter: new FakeMinter() }),
      taskFor: () => null,
      log: () => {},
    })
    servers.push(server)

    expect(
      (await askMinter(server.socketPath, { session: SESSION, operation: 'get' })).token,
    ).toBe('token-1')
  })

  it('is gone once roma has stopped answering on it', async () => {
    const { server } = await listening()
    const path = server.socketPath

    await server.close()
    servers = servers.filter((other) => other !== server)

    expect(existsSync(path)).toBe(false)
  })
})
