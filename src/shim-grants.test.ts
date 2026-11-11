import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CloudGrantAsked,
  Entitlement,
  Grant,
  GrantAsked,
  Grants,
  RequestsGrants,
} from './grants.js'
import { askMinter } from './shim-client.js'
import { socketPathIn } from './shim-protocol.js'
import { ShimServer, type ShimLogRecord } from './shim-server.js'
import { fakeServedReaches } from '../test/support/fake-minter.js'

const SESSION = 'a-session'
const ENTITLEMENT = 'projects/p1/locations/global/entitlements/read-bucket'

const FOUND: Entitlement = {
  name: ENTITLEMENT,
  bindings: [{ role: 'roles/storage.objectViewer', condition: null }],
  maxDurationS: 3600,
}

class FakeRequests implements RequestsGrants {
  readonly asked: GrantAsked[] = []
  readonly looked: string[] = []
  failWith: Error | null = null
  onRequest: () => void = () => {}

  entitlements(): readonly Entitlement[] {
    return [FOUND]
  }

  request(asked: GrantAsked): Promise<Grant> {
    this.asked.push(asked)
    this.onRequest()
    if (this.failWith !== null) return Promise.reject(this.failWith)
    return Promise.resolve({
      name: `${asked.entitlement}/grants/g1`,
      state: 'APPROVAL_AWAITED',
      entitlement: asked.entitlement,
      approveAt: 'https://console.example.test/approve',
      bindings: FOUND.bindings,
      resource: null,
    })
  }

  status(name: string): Promise<Grant> {
    this.looked.push(name)
    return Promise.resolve({
      name,
      state: 'ACTIVE',
      entitlement: ENTITLEMENT,
      approveAt: null,
      bindings: [],
      resource: null,
    })
  }
}

let dirs: string[] = []
let servers: ShimServer[] = []

afterEach(async () => {
  for (const server of servers) await server.close()
  servers = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

async function listening({
  grants,
  taskFor = () => 'task-7' as string | null,
  holder,
}: {
  grants?: Grants
  taskFor?: () => string | null
  holder?: () => string | null
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roma-shim-grants-'))
  dirs.push(dir)
  const log: ShimLogRecord[] = []
  const granted: [string, string][] = []
  const told: CloudGrantAsked[] = []
  const server = await ShimServer.listen({
    socketPath: socketPathIn(dir),
    reaches: fakeServedReaches(),
    taskFor,
    ...(holder === undefined ? {} : { holder }),
    ...(grants === undefined ? {} : { grants }),
    onGrant: (taskId, asked) => {
      granted.push([taskId, asked.grant.name])
      told.push(asked)
    },
    log: (record) => log.push(record),
  })
  servers.push(server)
  return { server, log, granted, told }
}

const REQUEST = {
  session: SESSION,
  operation: 'grant' as const,
  credential: 'cloud' as const,
  grant: { entitlement: 'read-bucket', durationS: 1800, justification: 'read the export' },
}

describe('asking roma for a Cloud Grant', () => {
  it('requests it with the Task stamped on, and answers with the grant', async () => {
    const requests = new FakeRequests()
    const { server, granted, log, told } = await listening({ grants: { requests } })

    const answer = await askMinter(server.socketPath, REQUEST)

    expect(told[0]).toMatchObject({
      entitlement: FOUND,
      durationS: 1800,
      justification: 'roma Task task-7: read the export',
    })

    expect(requests.asked).toEqual([
      {
        entitlement: ENTITLEMENT,
        durationS: 1800,
        justification: 'roma Task task-7: read the export',
      },
    ])
    expect(answer).toEqual({
      token: null,
      grant: {
        name: `${ENTITLEMENT}/grants/g1`,
        state: 'APPROVAL_AWAITED',
        entitlement: ENTITLEMENT,
        approveAt: 'https://console.example.test/approve',
        bindings: FOUND.bindings,
        resource: null,
      },
    })
    expect(granted).toEqual([['task-7', `${ENTITLEMENT}/grants/g1`]])
    expect(log).toContainEqual(
      expect.objectContaining({
        event: 'cloud-grant',
        taskId: 'task-7',
        state: 'APPROVAL_AWAITED',
      }),
    )
  })

  it('says how a grant stands, without counting it as asked for', async () => {
    const requests = new FakeRequests()
    const { server, granted } = await listening({ grants: { requests } })

    const answer = await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'grant-status',
      credential: 'cloud',
      grantName: `${ENTITLEMENT}/grants/g1`,
    })

    expect(answer.grant?.state).toBe('ACTIVE')
    expect(granted).toEqual([])
  })

  it('refuses before asking Google when the Session runs no Task', async () => {
    const requests = new FakeRequests()
    const { server, log } = await listening({ grants: { requests }, taskFor: () => null })

    const answer = await askMinter(server.socketPath, REQUEST)

    expect(answer.token).toBeNull()
    expect(answer.reason).toContain('no Task is running')
    expect(requests.asked).toEqual([])
    expect(log).toContainEqual(expect.objectContaining({ event: 'cloud-grant-refused' }))
  })

  it('refuses a grant name it did not find an entitlement for', async () => {
    const requests = new FakeRequests()
    const { server } = await listening({ grants: { requests } })

    const answer = await askMinter(server.socketPath, {
      session: SESSION,
      operation: 'grant-status',
      credential: 'cloud',
      grantName: 'projects/p1/locations/global/entitlements/owner/grants/g1',
    })

    expect(answer.reason).toContain('is not a grant under any entitlement')
    expect(requests.looked).toEqual([])
  })

  it('answers with the sentence when this roma has no Cloud Grants', async () => {
    const { server } = await listening({ grants: { unavailable: 'no grants here.' } })

    const answer = await askMinter(server.socketPath, REQUEST)

    expect(answer).toEqual({ token: null, reason: 'no grants here.' })
  })

  it('passes on what Google said when it refuses', async () => {
    const requests = new FakeRequests()
    requests.failWith = new Error('Google refused to request a grant, with 403')
    const { server, granted } = await listening({ grants: { requests } })

    const answer = await askMinter(server.socketPath, REQUEST)

    expect(answer.reason).toContain('403')
    expect(granted).toEqual([])
  })

  it('refuses a Session the socket does not belong to', async () => {
    const requests = new FakeRequests()
    const { server } = await listening({ grants: { requests }, holder: () => 'someone-else' })

    const answer = await askMinter(server.socketPath, REQUEST)

    expect(answer.reason).toContain('does not belong to that Session')
    expect(requests.asked).toEqual([])
  })

  it('records a grant Google made even when the Seat moved on meanwhile [fence:cloud-grant-recorded-even-if-the-seat-moved]', async () => {
    const requests = new FakeRequests()
    let holder: string = SESSION
    requests.onRequest = () => {
      holder = 'the-next-session'
    }
    const { server, granted, log } = await listening({ grants: { requests }, holder: () => holder })

    const answer = await askMinter(server.socketPath, REQUEST)

    expect(answer.reason).toContain('does not belong to that Session')
    expect(
      granted,
      'Once PAM has made the grant it exists in Google whether or not this Seat still holds the ' +
        'Session, so the Conversation is told and the Audit Record lists it (ADR-0041 §6, §7).',
    ).toEqual([['task-7', `${ENTITLEMENT}/grants/g1`]])
    expect(log).toContainEqual(expect.objectContaining({ event: 'cloud-grant' }))
  })
})
