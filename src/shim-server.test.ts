import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { askMinter } from './shim-client.js'
import { socketPathIn, type CredentialWanted } from './shim-protocol.js'
import { NO_CLOUD_REACH } from './cloud/reach.js'
import { FreshTokens } from './fresh-tokens.js'
import { ShimServer, type ServedReaches, type ShimLogRecord } from './shim-server.js'
import { FakeCloudMinter, FakeMinter, fakeServedReaches } from '../test/support/fake-minter.js'

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
  cloudMinter,
  taskFor = () => 'the-task' as string | null,
}: {
  minter?: FakeMinter
  cloudMinter?: FakeCloudMinter
  taskFor?: () => string | null
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roma-shim-server-'))
  dirs.push(dir)
  const log: ShimLogRecord[] = []
  const cloudTokensFor: (string | null)[] = []
  const server = await ShimServer.listen({
    socketPath: socketPathIn(dir),
    reaches: fakeServedReaches({ minter, cloudMinter: cloudMinter ?? null }),
    onCredential: (taskId: string | null, credential: CredentialWanted) => {
      if (credential === 'cloud') cloudTokensFor.push(taskId)
    },
    taskFor,
    log: (record) => log.push(record),
  })
  servers.push(server)
  return { server, minter, cloudMinter, log, dir, cloudTokensFor }
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

  it('answers with no credential and the reason when minting fails [fence:shim-no-credential-is-an-answer]', async () => {
    const why =
      'roma answering "no credential, and here is why" is a successful exchange, and askMinter ' +
      'must resolve with it rather than reject (#62). The reason is what the Shim has to pass ' +
      'on; lost to an exception, the tool says "authentication failed" with nothing behind it.'
    const minter = new FakeMinter()
    minter.failsWith = new Error('the App private key was rejected')
    const { server } = await listening({ minter })

    const answer = await askMinter(server.socketPath, { session: SESSION, operation: 'get' }).catch(
      (error: unknown) => ({ token: 'rejected', reason: String(error) }),
    )

    expect(answer.token, why).toBeNull()
    expect(answer.reason, why).toContain('private key')
  })

  it('survives something that is not a Shim talking to it', async () => {
    const { server, log } = await listening()

    const answer = await askMinter(server.socketPath, {
      session: '',
      operation: 'get',
    })

    expect(answer.token).toBeNull()
    expect(log).toContainEqual(expect.objectContaining({ event: 'shim-unreadable' }))
    expect((await askMinter(server.socketPath, { session: SESSION, operation: 'get' })).token).toBe(
      'token-1',
    )
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
      {
        event: 'credential',
        sessionId: SESSION,
        taskId: 'the-task',
        path: 'a-team/roma.git',
        credential: 'code',
      },
    ])
  })

  it('records a request that belongs to no running Task as belonging to none', async () => {
    const { server, log } = await listening({ taskFor: () => null })

    await askMinter(server.socketPath, { session: SESSION, operation: 'get' })

    expect(log).toEqual([
      { event: 'credential', sessionId: SESSION, taskId: null, path: null, credential: 'code' },
    ])
  })
})

describe('answering the Cloud Shortcut', () => {
  it('hands over a Cloud Token, with its expiry and the identity it acts as', async () => {
    const cloudMinter = new FakeCloudMinter()
    const { server } = await listening({ cloudMinter })

    const answer = await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'get',
      credential: 'cloud',
    })

    expect(answer.token).toBe('cloud-token-1')
    expect(answer.account).toBe(cloudMinter.account)
    expect(answer.expiresAt).toBe(cloudMinter.minted[0]?.expiresAt)
  })

  it('serves a second request inside the hour without minting again', async () => {
    const cloudMinter = new FakeCloudMinter()
    const { server } = await listening({ cloudMinter })

    const first = await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'get',
      credential: 'cloud',
    })
    const second = await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'get',
      credential: 'cloud',
    })

    expect(second.token).toBe(first.token)
    expect(cloudMinter.minted).toHaveLength(1)
  })

  it('says there is no Cloud Reach rather than hanging or failing', async () => {
    const { server, log } = await listening()

    const answer = await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'get',
      credential: 'cloud',
    })

    expect(answer.token).toBeNull()
    expect(answer.reason).toBe(NO_CLOUD_REACH)
    expect(log).toEqual([
      expect.objectContaining({ event: 'credential-failed', credential: 'cloud' }),
    ])
  })

  it('leaves a request for the other credential completely alone [fence:shim-each-credential-from-its-own-reach]', async () => {
    const why =
      'Every answer to a request must come from the one Reach the request names, looked up once ' +
      '(ADR-0020 §9). Which credential a request is about is the only question that branches ' +
      'there, and asked in several places it can be answered differently in one of them — the ' +
      'worst of which hands the Cloud Shortcut an Installation Token, and looks like everything ' +
      'working until the first API call (#119).'
    const { server } = await listening({ cloudMinter: new FakeCloudMinter() })

    const code = await askMinter(server.socketPath, { session: SESSION, operation: 'get' })
    const cloud = await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'get',
      credential: 'cloud',
    })

    expect(code.token, why).toBe('token-1')
    expect(cloud.token, why).toBe('cloud-token-1')
    expect(code.account, why).toBe('a-team')
    expect(cloud.account, why).toBe('agent@a-project.iam.gserviceaccount.com')
  })

  it('carries the reason when the Cloud Reach’s key has stopped working', async () => {
    const cloudMinter = new FakeCloudMinter()
    cloudMinter.failsWith = new Error('the service account key was revoked')
    const { server } = await listening({ cloudMinter })

    const answer = await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'get',
      credential: 'cloud',
    })

    expect(answer.token).toBeNull()
    expect(answer.reason).toContain('revoked')
  })

  it('refuses a credential it does not recognise rather than defaulting [fence:shim-unknown-credential-refused]', async () => {
    const why =
      'A request naming a credential roma does not know must be refused, never defaulted to ' +
      '`code` (#99): defaulting answers a request for a credential roma lacks with one it has — ' +
      'for the Cloud Shortcut, an Installation Token printed as though it were a Cloud Token.'
    const { server, log } = await listening({ cloudMinter: new FakeCloudMinter() })

    const answer = await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'get',
      credential: 'aws' as 'cloud',
    })

    expect(answer.token, why).toBeNull()
    expect(log, why).toContainEqual(expect.objectContaining({ event: 'shim-unreadable' }))
  })

  it('erases only from the Reach the request names [fence:shim-erase-routed-by-reach]', async () => {
    const why =
      'An erase must be routed by the Reach it names, never by the token alone (#99). Otherwise ' +
      'an agent can hand back the Installation Token labelled `cloud` and force a re-mint of ' +
      'the token every Session is using — the forge’s credential dropped by naming the wrong side. ' +
      'It is answered ahead of the unavailable-Reach answer, so an erase for a Reach roma has none ' +
      'of is still recorded as a rejection, never as a failure.'
    const { server, minter, log } = await listening({ cloudMinter: new FakeCloudMinter() })
    const code = await askMinter(server.socketPath, { session: SESSION, operation: 'get' })

    for (const credential of ['cloud', 'documents'] as const) {
      await askMinter(server.socketPath, {
        session: SESSION,
        operation: 'erase',
        token: code.token,
        credential,
      })
    }
    const again = await askMinter(server.socketPath, { session: SESSION, operation: 'get' })

    expect(again.token, why).toBe(code.token)
    expect(minter.minted, why).toHaveLength(1)
    expect(
      log.filter(({ event }) => event !== 'credential').map((record) => record.event),
      why,
    ).toEqual(['credential-rejected', 'credential-rejected'])
  })

  it('names only the credentials roma has a Reach for [fence:shim-credential-wanted-is-closed]', () => {
    const why =
      'CredentialWanted is a closed union and ServedReaches is total over it, so a new member ' +
      'is a compile error at the composition root until it is wired (ADR-0020 §8, #132). ' +
      'Widened to string, or made partial, a credential member can exist that nothing serves.'
    // @ts-expect-error -- fence:shim-credential-wanted-is-closed
    const unknown: CredentialWanted = 'drive'
    // @ts-expect-error -- fence:shim-credential-wanted-is-closed
    const partial: ServedReaches = { code: { unavailable: 'x' }, cloud: { unavailable: 'x' } }

    expect(Object.keys(fakeServedReaches()).sort(), why).toEqual(['cloud', 'code', 'documents'])
    expect([unknown, Object.keys(partial).length], why).toEqual(['drive', 2])
  })
})

describe('which Task obtained a Cloud Token', () => {
  it('names the Task its Session was running', async () => {
    const { server, cloudTokensFor } = await listening({ cloudMinter: new FakeCloudMinter() })

    await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'get',
      credential: 'cloud',
    })

    expect(cloudTokensFor).toEqual(['the-task'])
  })

  it('says nothing about a Task that only asked for the other credential', async () => {
    const { server, cloudTokensFor } = await listening({ cloudMinter: new FakeCloudMinter() })

    await askMinter(server.socketPath, { session: SESSION, operation: 'get' })

    expect(cloudTokensFor).toEqual([])
  })

  it('says nothing when there was no Cloud Token to hand over', async () => {
    const { server, cloudTokensFor } = await listening()

    await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'get',
      credential: 'cloud',
    })

    expect(cloudTokensFor).toEqual([])
  })
})

describe('the socket itself', () => {
  it('is taken over from a boot that did not clean up [fence:shim-stale-socket-taken-over]', async () => {
    const why =
      'listen must remove a stale socket file before taking the path (#62). A container killed ' +
      'rather than stopped leaves the file behind, and listen on an existing path fails with ' +
      'EADDRINUSE — roma refusing to boot after every hard restart, over a file nothing serves.'
    const dir = mkdtempSync(join(tmpdir(), 'roma-shim-server-'))
    dirs.push(dir)
    writeFileSync(socketPathIn(dir), '')

    const server = await ShimServer.listen({
      socketPath: socketPathIn(dir),
      reaches: fakeServedReaches(),
      taskFor: () => null,
      log: () => {},
    }).catch((error: unknown) => expect.unreachable(`${why}\n${String(error)}`))
    servers.push(server)

    expect(
      (await askMinter(server.socketPath, { session: SESSION, operation: 'get' })).token,
      why,
    ).toBe('token-1')
  })

  it('stops even with a Shim that connected and never spoke [fence:shim-close-cuts-open-connections]', async () => {
    const why =
      'close must cut the connections still open rather than wait for them (#60, #62). ' +
      'net.Server.close waits for every one and has no closeAllConnections, so a Shim that ' +
      'connects and never speaks would otherwise be the reason roma does not shut down.'
    const { server } = await listening()
    const silent = connect(server.socketPath)
    await new Promise((connected) => silent.once('connect', connected))
    silent.on('error', () => {})

    const closing = server.close().then(() => 'closed')
    const outcome = await Promise.race([closing, sleep(1_000).then(() => 'still waiting')])
    silent.destroy()
    await closing
    servers = servers.filter((other) => other !== server)

    expect(outcome, why).toBe('closed')
  })

  it('is gone once roma has stopped answering on it', async () => {
    const { server } = await listening()
    const path = server.socketPath

    await server.close()
    servers = servers.filter((other) => other !== server)

    expect(existsSync(path)).toBe(false)
  })
})

describe('when a credential is written down', () => {
  it('names the Task running once the token is in hand [fence:shim-attributes-at-service]', async () => {
    const why =
      'The Task a credential is attributed to must be looked up once the token is in hand, ' +
      'never before the mint is awaited (GHSA-4vw6-r2rj-xcqf). A mint can take seconds; a ' +
      'Task that ends in that time would be marked for a token it never saw, and the next ' +
      'one missed.'
    let running: string | null = 'task-1'
    let release: () => void = () => {}
    const minted = new Promise<void>((done) => (release = done))
    const gated = {
      mint: async () => {
        await minted
        return { token: 'gated-token', expiresAt: Date.now() + 3_600_000 }
      },
    }
    const dir = mkdtempSync(join(tmpdir(), 'roma-shim-server-'))
    dirs.push(dir)
    const credited: (string | null)[] = []
    const log: ShimLogRecord[] = []
    const server = await ShimServer.listen({
      socketPath: socketPathIn(dir),
      reaches: {
        ...fakeServedReaches(),
        cloud: { account: null, tokens: new FreshTokens({ minter: gated }) },
      },
      onCredential: (taskId) => credited.push(taskId),
      taskFor: () => running,
      log: (record) => log.push(record),
    })
    servers.push(server)

    const asking = askMinter(server.socketPath, {
      session: SESSION,
      operation: 'get',
      credential: 'cloud',
    })
    await sleep(20)
    running = 'task-2'
    release()
    const answer = await asking

    expect(answer.token, why).toBe('gated-token')
    expect(credited, why).toEqual(['task-2'])
    expect(log, why).toEqual([expect.objectContaining({ event: 'credential', taskId: 'task-2' })])
  })
})

describe('a Seat socket handed from one Session to the next', () => {
  async function seated(
    holder: () => string | null,
    minter: { mint: FakeMinter['mint'] },
    lease: () => object | null = () => null,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'roma-shim-server-'))
    dirs.push(dir)
    const credited: (string | null)[] = []
    const log: ShimLogRecord[] = []
    const server = await ShimServer.listen({
      socketPath: socketPathIn(dir),
      reaches: {
        ...fakeServedReaches(),
        cloud: { account: null, tokens: new FreshTokens({ minter }) },
      },
      onCredential: (taskId) => credited.push(taskId),
      taskFor: (sessionId) => `task-of-${sessionId}`,
      holder,
      lease,
      log: (record) => log.push(record),
    })
    servers.push(server)
    return { server, credited, log }
  }

  it('refuses a connection from an earlier lease, even when the same Session holds the Seat again [fence:shim-connection-belongs-to-its-lease]', async () => {
    const why =
      'GHSA-4vw6-r2rj-xcqf: a Session can come back to the Seat it had. A connection from ' +
      'its first lease, kept by another Seat, would speak for it again unless the lease ' +
      'itself, not just the Session it names, is what the connection belongs to.'
    let current: object | null = {}
    const { server, credited, log } = await seated(
      () => 'session-a',
      new FakeCloudMinter(),
      () => current,
    )

    const held = connect(server.socketPath)
    await new Promise<void>((ready) => held.once('connect', () => ready()))
    await sleep(20)
    current = {}
    let reply = ''
    held.setEncoding('utf8')
    held.on('data', (chunk: string) => (reply += chunk))
    const ended = new Promise<void>((done) => held.on('end', () => done()))
    held.write(
      `${JSON.stringify({ session: 'session-a', operation: 'get', credential: 'cloud' })}\n`,
    )
    await ended

    expect(JSON.parse(reply), why).toMatchObject({ token: null })
    expect(credited, why).toEqual([])
    expect(log, why).toEqual([
      expect.objectContaining({ event: 'credential-refused', claimed: 'session-a' }),
    ])
  })

  it('refuses a connection opened under the last holder, whoever it names now [fence:shim-connection-belongs-to-its-holder]', async () => {
    const why =
      'GHSA-4vw6-r2rj-xcqf: a Session opened connections before its Seat was returned and ' +
      'passed them to another Seat; once the Seat was the next Session’s, every request on ' +
      'them was written down as that Session’s Task.'
    let holder: string | null = 'session-a'
    const { server, credited, log } = await seated(() => holder, new FakeCloudMinter())

    const held = connect(server.socketPath)
    await new Promise<void>((ready) => held.once('connect', () => ready()))
    await sleep(20)
    holder = 'session-c'
    let reply = ''
    held.setEncoding('utf8')
    held.on('data', (chunk: string) => (reply += chunk))
    const ended = new Promise<void>((done) => held.on('end', () => done()))
    held.write(
      `${JSON.stringify({ session: 'session-c', operation: 'get', credential: 'cloud' })}\n`,
    )
    await ended

    expect(JSON.parse(reply), why).toMatchObject({ token: null })
    expect(credited, why).toEqual([])
    expect(log, why).toEqual([
      expect.objectContaining({ event: 'credential-refused', claimed: 'session-c' }),
    ])
  })

  it('refuses a token whose Seat changed hands while it was being minted [fence:shim-holder-rechecked-after-mint]', async () => {
    const why =
      'GHSA-4vw6-r2rj-xcqf: a mint can take seconds. A request that began under one holder ' +
      'and was answered under the next was handed the token and written down for nobody.'
    let holder: string | null = 'session-a'
    let release: () => void = () => {}
    const minted = new Promise<void>((done) => (release = done))
    const { server, credited, log } = await seated(() => holder, {
      mint: async () => {
        await minted
        return { token: 'gated-token', expiresAt: Date.now() + 3_600_000 }
      },
    })

    const asking = askMinter(server.socketPath, {
      session: 'session-a',
      operation: 'get',
      credential: 'cloud',
    })
    await sleep(20)
    holder = 'session-b'
    release()
    const answer = await asking

    expect(answer.token, why).toBeNull()
    expect(credited, why).toEqual([])
    expect(log, why).toEqual([
      expect.objectContaining({
        event: 'credential-refused',
        claimed: 'session-a',
        holder: 'session-b',
      }),
    ])
  })
})
