import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { Entitlement, Grant, GrantAsked, Grants } from '../grants.js'
import { MINTER_SOCKET_VAR, SESSION_ID_VAR, socketPathIn } from '../shim-protocol.js'
import { ShimServer } from '../shim-server.js'
import { fakeServedReaches } from '../../test/support/fake-minter.js'
import { askedBy, durationSeconds, main } from './cloud-grant.js'

const ENTITLEMENT = 'projects/p1/locations/global/entitlements/read-bucket'

let dirs: string[] = []
let servers: ShimServer[] = []

afterEach(async () => {
  for (const server of servers) await server.close()
  servers = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function grantsAsked(): { grants: Grants; asked: GrantAsked[] } {
  const asked: GrantAsked[] = []
  const found: Entitlement = { name: ENTITLEMENT, bindings: [], maxDurationS: 3600 }
  return {
    asked,
    grants: {
      requests: {
        entitlements: () => [found],
        request: (grant: GrantAsked): Promise<Grant> => {
          asked.push(grant)
          return Promise.resolve({
            name: `${ENTITLEMENT}/grants/g1`,
            state: 'APPROVAL_AWAITED',
            entitlement: ENTITLEMENT,
            approveAt: 'https://console.example.test/approve',
            bindings: [],
            resource: null,
          })
        },
        status: (name: string): Promise<Grant> =>
          Promise.resolve({
            name,
            state: 'ACTIVE',
            entitlement: ENTITLEMENT,
            approveAt: null,
            bindings: [],
            resource: null,
          }),
      },
    },
  }
}

async function run(argv: readonly string[], grants: Grants) {
  const dir = mkdtempSync(join(tmpdir(), 'roma-cloud-grant-'))
  dirs.push(dir)
  const server = await ShimServer.listen({
    socketPath: socketPathIn(dir),
    reaches: fakeServedReaches(),
    taskFor: () => 'task-3',
    grants,
    log: () => {},
  })
  servers.push(server)
  const out = new PassThrough()
  const err = new PassThrough()
  const code = await main(
    argv,
    { [MINTER_SOCKET_VAR]: server.socketPath, [SESSION_ID_VAR]: 's' },
    out,
    err,
  )
  return { code, stdout: String(out.read() ?? ''), stderr: String(err.read() ?? '') }
}

describe('the Cloud Grant Shortcut', () => {
  it('asks roma for a grant and prints one line about it', async () => {
    const { grants, asked } = grantsAsked()

    const ran = await run(['request', 'read-bucket', '30m', 'read', 'the', 'export'], grants)

    expect(ran.code).toBe(0)
    expect(JSON.parse(ran.stdout)).toEqual({
      grant: `${ENTITLEMENT}/grants/g1`,
      state: 'APPROVAL_AWAITED',
      entitlement: ENTITLEMENT,
      approve: 'https://console.example.test/approve',
    })
    expect(asked[0]?.justification).toBe('roma Task task-3: read the export')
  })

  it('says how a grant stands', async () => {
    const { grants } = grantsAsked()

    const ran = await run(['status', `${ENTITLEMENT}/grants/g1`], grants)

    expect(JSON.parse(ran.stdout)).toMatchObject({ state: 'ACTIVE' })
  })

  it('passes roma’s refusal on, and fails', async () => {
    const ran = await run(['request', 'read-bucket', '30m', 'why'], { unavailable: 'none here.' })

    expect(ran).toEqual({ code: 1, stdout: '', stderr: 'roma-cloud-grant: none here.\n' })
  })

  it('says how it is used when it is used wrongly', async () => {
    const { grants } = grantsAsked()

    const ran = await run(['request', 'read-bucket'], grants)

    expect(ran.code).toBe(2)
    expect(ran.stderr).toContain('request takes an entitlement, a duration and a justification')
  })
})

describe('reading what the agent wrote', () => {
  it('reads a duration in seconds, minutes or hours', () => {
    expect(durationSeconds('1800')).toBe(1800)
    expect(durationSeconds('45s')).toBe(45)
    expect(durationSeconds('30m')).toBe(1800)
    expect(durationSeconds('2h')).toBe(7200)
    expect(durationSeconds('1.5h')).toBeNull()
    expect(durationSeconds('soon')).toBeNull()
  })

  it('takes nothing but request and status', () => {
    expect(askedBy([])).toMatchObject({ misused: expect.any(String) })
    expect(askedBy(['approve', 'g'])).toMatchObject({ misused: expect.any(String) })
    expect(askedBy(['status', 'a', 'b'])).toMatchObject({ misused: expect.any(String) })
    expect(askedBy(['request', 'e', 'later', 'why'])).toMatchObject({
      misused: expect.stringContaining('is not a duration'),
    })
  })
})
