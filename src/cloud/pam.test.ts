import { describe, expect, it } from 'vitest'
import {
  approvalsFor,
  entitlementFrom,
  GrantRefused,
  isGrantScope,
  PAM_API,
  PamGrants,
  secondsOf,
} from './pam.js'

interface Call {
  readonly url: string
  readonly method: string
  readonly authorization: string | null
  readonly body: unknown
}

const ENTITLEMENT = 'projects/p1/locations/global/entitlements/read-bucket'

const RAW_ENTITLEMENT = {
  name: ENTITLEMENT,
  maxRequestDuration: '3600s',
  privilegedAccess: {
    gcpIamAccess: {
      resourceType: 'cloudresourcemanager.googleapis.com/Project',
      resource: '//cloudresourcemanager.googleapis.com/projects/p1',
      roleBindings: [
        {
          role: 'roles/storage.objectViewer',
          conditionExpression: 'resource.name == "projects/_/buckets/b"',
        },
      ],
    },
  },
}

function pam(reply: (call: Call) => { status?: number; body: unknown }, scopes = ['projects/p1']) {
  const calls: Call[] = []
  let minted = 0
  const fetch: typeof globalThis.fetch = (input, init) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    const { status = 200, body } = reply(call)
    return Promise.resolve(new Response(JSON.stringify(body), { status }))
  }
  const grants = new PamGrants({
    minter: {
      mint: () => {
        minted += 1
        return Promise.resolve({
          token: `ya29.t${String(minted)}`,
          expiresAt: Date.now() + 3600_000,
        })
      },
    },
    scopes,
    fetch,
  })
  return { grants, calls, minted: () => minted }
}

describe('finding what the Cloud Reach may request', () => {
  it('asks PAM, as the Cloud Reach, for what it is a requester of', async () => {
    const { grants, calls } = pam(() => ({ body: { entitlements: [RAW_ENTITLEMENT] } }))

    expect(await grants.find()).toEqual([
      {
        name: ENTITLEMENT,
        roles: ['roles/storage.objectViewer'],
        conditions: ['resource.name == "projects/_/buckets/b"'],
        maxDurationS: 3600,
      },
    ])
    const url = new URL(calls[0]!.url)
    expect(`${url.origin}${url.pathname}`).toBe(
      `${PAM_API}/projects/p1/locations/global/entitlements:search`,
    )
    expect(url.searchParams.get('callerAccessType')).toBe('GRANT_REQUESTER')
    expect(calls[0]!.authorization).toBe('Bearer ya29.t1')
  })

  it('follows every page', async () => {
    const { grants, calls } = pam(({ url }) =>
      new URL(url).searchParams.get('pageToken') === null
        ? { body: { entitlements: [RAW_ENTITLEMENT], nextPageToken: 'next' } }
        : { body: { entitlements: [{ ...RAW_ENTITLEMENT, name: `${ENTITLEMENT}-2` }] } },
    )

    expect((await grants.find()).map(({ name }) => name)).toEqual([ENTITLEMENT, `${ENTITLEMENT}-2`])
    expect(calls).toHaveLength(2)
  })

  it('refuses a scope where the Cloud Reach may request nothing', async () => {
    const { grants } = pam(() => ({ body: {} }))

    await expect(grants.find()).rejects.toThrow('eligible for no entitlement in projects/p1')
  })

  it('says what Google said when it refuses', async () => {
    const { grants } = pam(() => ({ status: 403, body: { error: { message: 'denied' } } }))

    await expect(grants.find()).rejects.toBeInstanceOf(GrantRefused)
  })

  it('reuses one Cloud Token across calls', async () => {
    const { grants, minted } = pam(
      () => ({ body: { entitlements: [RAW_ENTITLEMENT] } }),
      ['projects/p1', 'projects/p2'],
    )

    await grants.find()

    expect(minted()).toBe(1)
  })

  it('will not list entitlements it has not found yet', () => {
    const { grants } = pam(() => ({ body: {} }))

    expect(() => grants.entitlements()).toThrow('before finding them')
  })
})

describe('requesting a grant', () => {
  it('posts the duration and the justification it was handed, unchanged', async () => {
    const { grants, calls } = pam(() => ({
      body: { name: `${ENTITLEMENT}/grants/g1`, state: 'APPROVAL_AWAITED' },
    }))

    const grant = await grants.request({
      entitlement: ENTITLEMENT,
      durationS: 1800,
      justification: 'roma Task t1: read the export',
    })

    expect(calls[0]).toMatchObject({
      url: `${PAM_API}/${ENTITLEMENT}/grants`,
      method: 'POST',
      body: {
        requestedDuration: '1800s',
        justification: { unstructuredJustification: 'roma Task t1: read the export' },
      },
    })
    expect(grant).toEqual({
      name: `${ENTITLEMENT}/grants/g1`,
      state: 'APPROVAL_AWAITED',
      entitlement: ENTITLEMENT,
      approveAt: 'https://console.cloud.google.com/iam-admin/pam/grants/approvals?project=p1',
    })
  })

  it('says how a grant stands', async () => {
    const { grants, calls } = pam(() => ({
      body: { name: `${ENTITLEMENT}/grants/g1`, state: 'ACTIVE' },
    }))

    expect((await grants.status(`${ENTITLEMENT}/grants/g1`)).state).toBe('ACTIVE')
    expect(calls[0]).toMatchObject({ url: `${PAM_API}/${ENTITLEMENT}/grants/g1`, method: 'GET' })
  })

  it('passes a refusal on as one', async () => {
    const { grants } = pam(() => ({ status: 400, body: { error: { message: 'too long' } } }))

    await expect(
      grants.request({ entitlement: ENTITLEMENT, durationS: 1800, justification: 'x' }),
    ).rejects.toThrow('Google refused to request a grant')
  })
})

describe('reading what Google says', () => {
  it('reads a duration in seconds, and nothing else', () => {
    expect(secondsOf('3600s')).toBe(3600)
    expect(secondsOf('3600.5s')).toBe(3600)
    expect(secondsOf('1h')).toBeNull()
    expect(secondsOf(3600)).toBeNull()
  })

  it('drops an entitlement it cannot read', () => {
    expect(entitlementFrom({ name: ENTITLEMENT })).toBeNull()
  })

  it('takes projects, folders and organizations as scopes, and nothing else', () => {
    expect(isGrantScope('projects/p1')).toBe(true)
    expect(isGrantScope('folders/123')).toBe(true)
    expect(isGrantScope('organizations/9')).toBe(true)
    expect(isGrantScope('projects/p1/locations/global')).toBe(false)
    expect(isGrantScope('buckets/b')).toBe(false)
  })

  it('points at the console page where a person approves', () => {
    expect(approvalsFor('folders/12/locations/global/entitlements/e/grants/g')).toBe(
      'https://console.cloud.google.com/iam-admin/pam/grants/approvals?folder=12',
    )
    expect(approvalsFor('organizations/9/locations/global')).toBe(
      'https://console.cloud.google.com/iam-admin/pam/grants/approvals?organizationId=9',
    )
  })
})
