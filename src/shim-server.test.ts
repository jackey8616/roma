import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { askMinter } from './shim-client.js'
import { socketPathIn, type CredentialWanted } from './shim-protocol.js'
import { NO_CLOUD_REACH } from './cloud/reach.js'
import { ShimServer, type ServedReaches, type ShimLogRecord } from './shim-server.js'
import { FakeCloudMinter, FakeMinter, fakeServedReaches } from '../test/support/fake-minter.js'

/**
 * roma's side of the credential contract, over a real socket.
 *
 * A real Unix domain socket rather than a stubbed transport, because the socket
 * *is* the decision: a TCP port would be reachable by anything on the host, and
 * "one line in, one line out, then closed" is the protocol both Credential Shims
 * and the Cloud Shortcut are written against. There is nothing slow or
 * unreachable about it — the two ends are in the same process.
 *
 * It is also the highest point at which the whole contract is observable, which
 * is why the Cloud Reach is asserted here rather than against the pieces behind
 * it: what a caller can see is a token, an expiry, an account, or a sentence
 * saying why there is none.
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
  cloudMinter,
  taskFor = () => 'the-task' as string | null,
}: {
  minter?: FakeMinter
  /** Omitted, this roma has no Cloud Reach — which is the ordinary deployment. */
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
    // Every credential the socket serves, filtered here the way `startRoma`
    // filters it — which is the thing worth asserting now that the socket no
    // longer decides which one is interesting.
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

  // Nothing special happens when minting fails, and that is the decision: an
  // Outbound Instruction named after a product would mean the Core knows about
  // GitHub, and a circuit breaker would turn a forge outage into a roma outage
  // for the majority of Tasks that touch no repository.
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

  // A background process the agent left running, or work that outlived its
  // Task. Recorded as belonging to no Task rather than to the nearest one: the
  // same rule the Audit Record applies when it writes a Turn down as unpriced
  // rather than as free.
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

  // The whole reason the Shortcut is free to re-run: an agent should ask again
  // rather than reason about how much of the hour is left, and asking again
  // must not be a network round trip and a bill.
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

  // Most deployments have no Cloud Reach and that is not a fault. What must not
  // happen is a hang, a crash, or a stack trace — the Shortcut is installed on
  // every image precisely so that this sentence is what an agent reads.
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

  // The two credentials are different credentials. A `git` asking with a Cloud
  // Reach configured must not be handed a Cloud Token, and the Shortcut must not
  // be handed an Installation Token — which is the failure that would look like
  // everything working right up to the first API call.
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
    // Each answer carries *its own* Reach's account. Stronger than the assertion
    // this replaces, which only said the forge's answer had none: the mis-pairing
    // worth catching is a Reach served from another Reach's tokens, and after
    // ADR-0020 §9 built this record by mapping over the Reaches, nothing else in
    // the suite stands where the old ternary did.
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

  // Defaulting an unrecognised name to `code` would answer a request for a
  // credential roma does not have with one it does — which for the Cloud
  // Shortcut means printing an Installation Token as if it were a Cloud Token.
  it('refuses a credential it does not recognise rather than defaulting [fence:shim-unknown-credential-refused]', async () => {
    const why =
      'A request naming a credential roma does not know must be refused, never defaulted to ' +
      '`code` (#99): defaulting answers a request for a credential roma lacks with one it has — ' +
      'for the Cloud Shortcut, an Installation Token printed as though it were a Cloud Token.'
    const { server, log } = await listening({ cloudMinter: new FakeCloudMinter() })

    const answer = await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'get',
      // Something in the agent's userland can write anything to this socket.
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
    // @ts-expect-error -- fence:shim-credential-wanted-is-closed: a credential roma has no Reach for must not compile.
    const unknown: CredentialWanted = 'drive'
    // @ts-expect-error -- fence:shim-credential-wanted-is-closed: a ServedReaches missing a Reach must not compile.
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

  // A Task that reached for the forge and never for the cloud must not be
  // recorded as having used the Cloud Reach: the field is what narrows
  // unexplained activity on a service account to the people whose Tasks touched
  // it, and a false positive there points at the wrong person.
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
  // A container killed rather than stopped leaves the file behind, and `listen`
  // on an existing path fails with EADDRINUSE — which would present as roma
  // refusing to boot after every hard restart, for a file nothing is listening
  // on.
  it('is taken over from a boot that did not clean up [fence:shim-stale-socket-taken-over]', async () => {
    const why =
      'listen must remove a stale socket file before taking the path (#62). A container killed ' +
      'rather than stopped leaves the file behind, and listen on an existing path fails with ' +
      'EADDRINUSE — roma refusing to boot after every hard restart, over a file nothing serves.'
    const dir = mkdtempSync(join(tmpdir(), 'roma-shim-server-'))
    dirs.push(dir)
    // What a killed container leaves behind: the file, with nothing listening.
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
