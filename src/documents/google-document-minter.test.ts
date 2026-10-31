import { generateKeyPairSync, createPublicKey, createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DepotUnreachable,
  DocumentRefused,
  GoogleDocumentMinter,
} from './google-document-minter.js'

const KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const ACCOUNT = 'writer@a-project.iam.gserviceaccount.com'
const ENDPOINT = 'https://oauth2.example.test/token'
const DEPOT = 'FOLDER_ID'
const NOW = Date.parse('2026-08-03T12:00:00Z')

const SCOPES =
  'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly'

interface Exchange {
  readonly url: string
  readonly method: string
  readonly contentType: string
  readonly authorization: string
  readonly form: URLSearchParams
}

type Answer = { status?: number; body: unknown }

const A_TOKEN = (): Answer => ({
  body: { access_token: 'ya29.a-token', expires_in: 3599, token_type: 'Bearer' },
})

const A_DEPOT = (): Answer => ({
  body: {
    id: DEPOT,
    name: 'Team documents',
    capabilities: { canAddChildren: true, canEdit: true, canTrash: false, canDelete: false },
  },
})

function googleAnswering({
  token = A_TOKEN,
  depot = A_DEPOT,
}: { token?: () => Answer; depot?: () => Answer } = {}) {
  const exchanges: Exchange[] = []
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    exchanges.push({
      url,
      method: init?.method ?? 'GET',
      contentType: headers.get('content-type') ?? '',
      authorization: headers.get('authorization') ?? '',
      form: new URLSearchParams(String(init?.body ?? '')),
    })
    const { status = 200, body } = url === ENDPOINT ? token() : depot()
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'text/json' } }),
    )
  }
  return {
    exchanges,
    drive: () => exchanges.filter(({ url }) => url !== ENDPOINT),
    minter: new GoogleDocumentMinter({
      account: ACCOUNT,
      privateKey: PEM,
      tokenEndpoint: ENDPOINT,
      depot: DEPOT,
      fetch,
      now: () => NOW,
    }),
  }
}

function claimsOf(assertion: string): Record<string, unknown> {
  const payload = assertion.split('.')[1] ?? ''
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('exchanging the key for a Document Token', () => {
  it('reports the token and when Google says it dies', async () => {
    const { minter } = googleAnswering()

    expect(await minter.mint()).toEqual({ token: 'ya29.a-token', expiresAt: NOW + 3599 * 1000 })
  })

  it('posts a signed assertion to the endpoint the key named', async () => {
    const { minter, exchanges } = googleAnswering()

    await minter.mint()

    const exchange = exchanges[0]
    expect(exchange?.url).toBe(ENDPOINT)
    expect(exchange?.method).toBe('POST')
    expect(exchange?.contentType).toBe('application/x-www-form-urlencoded')
    expect(exchange?.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
  })

  it('asks for both Drive scopes and neither more, every time [fence:documents-both-drive-scopes]', async () => {
    const why =
      'A Document Token is scoped to exactly `drive.file` and `drive.readonly` (ADR-0022 §3). ' +
      '`drive.readonly` looks unused and is not: the Depot was not created by this app, so ' +
      '`drive.file` cannot read it, and without it the boot proof cannot see the Depot — found ' +
      'at the next deployment rather than at the edit. Nothing wider, because a scope a ' +
      'deployment could widen is a second boundary invisible from the first (#132).'
    const { minter, exchanges } = googleAnswering()

    await minter.mint()
    await minter.mint()

    for (const exchange of exchanges) {
      const claims = claimsOf(exchange.form.get('assertion') ?? '')
      expect(claims['scope'], why).toBe(SCOPES)
    }
  })

  it('asks for no Docs or Sheets scope at all', async () => {
    const { minter, exchanges } = googleAnswering()

    await minter.mint()

    const scope = String(claimsOf(exchanges[0]?.form.get('assertion') ?? '')['scope'])
    expect(scope).not.toContain('auth/spreadsheets')
    expect(scope).not.toContain('auth/documents')
  })

  it('signs as the account, for the endpoint it is being sent to', async () => {
    const { minter, exchanges } = googleAnswering()

    await minter.mint()

    const claims = claimsOf(exchanges[0]?.form.get('assertion') ?? '')
    expect(claims['iss']).toBe(ACCOUNT)
    expect(claims['aud']).toBe(ENDPOINT)
  })

  it('backdates the assertion rather than issuing it exactly now [fence:documents-assertion-is-backdated]', async () => {
    const why =
      'The assertion is issued a minute in the past (ADR-0022, as ADR-0015). A clock a few ' +
      'seconds fast issues one "in the future", Google rejects it, and roma fails to mint on ' +
      'a machine that is otherwise working perfectly (#132).'
    const { minter, exchanges } = googleAnswering()

    await minter.mint()

    const claims = claimsOf(exchanges[0]?.form.get('assertion') ?? '')
    expect(claims['iat'], why).toBe(Math.floor(NOW / 1000) - 60)
    expect(claims['exp'], why).toBe(Math.floor(NOW / 1000) - 60 + 3600)
  })

  it('is signed with the private key, RS256', async () => {
    const { minter, exchanges } = googleAnswering()
    await minter.mint()
    const assertion = exchanges[0]?.form.get('assertion') ?? ''

    const [header, payload, signature] = assertion.split('.')

    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'))).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    const verified = createVerify('RSA-SHA256')
      .update(`${String(header)}.${String(payload)}`)
      .verify(createPublicKey(PEM), Buffer.from(signature ?? '', 'base64url'))
    expect(verified).toBe(true)
  })

  it('carries Google’s refusal, with what it answered', async () => {
    const { minter } = googleAnswering({
      token: () => ({
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' },
      }),
    })

    await expect(minter.mint()).rejects.toThrow(DocumentRefused)
    await expect(minter.mint()).rejects.toThrow(/400.*Invalid JWT Signature/s)
  })

  it('treats a token with an unreadable lifetime as already spent [fence:documents-unreadable-lifetime-is-spent]', async () => {
    const why =
      'A Document Token whose lifetime cannot be read expires now: used once, never cached ' +
      '(ADR-0022). Guessing it long is the one direction that cannot be walked back — a token ' +
      'cached past its real life and served expired (#132).'
    const { minter } = googleAnswering({
      token: () => ({ body: { access_token: 'ya29.a-token', expires_in: 'about an hour' } }),
    })

    expect((await minter.mint()).expiresAt, why).toBe(NOW)
  })

  it('refuses an answer with no token in it', async () => {
    const { minter } = googleAnswering({ token: () => ({ body: { token_type: 'Bearer' } }) })

    await expect(minter.mint()).rejects.toThrow(/without an access token/)
  })
})

describe('proving the Depot is somewhere this identity can write', () => {
  it('asks for the folder’s capabilities, in a form that works on a shared drive', async () => {
    const { minter, drive } = googleAnswering()

    await minter.depot()

    const asked = drive()[0]?.url ?? ''
    expect(asked).toContain(`/drive/v3/files/${DEPOT}`)
    expect(asked).toContain('fields=id,name,capabilities')
    expect(asked).toContain('supportsAllDrives=true')
  })

  it('reaches Drive with a token it minted itself', async () => {
    const { minter, drive } = googleAnswering()

    await minter.depot()

    expect(drive()[0]?.authorization).toBe('Bearer ya29.a-token')
  })

  it('reports the folder as Drive named it', async () => {
    const { minter } = googleAnswering()

    expect(await minter.depot()).toEqual({ id: DEPOT, name: 'Team documents' })
  })

  it('does not ask Drive anything when the key cannot mint [fence:documents-depot-mints-its-own-token]', async () => {
    const why =
      'depot() mints its own token and refuses on the key before asking Drive anything ' +
      '(ADR-0022 §6). Handed a token instead, a revoked key is reported as a Depot or share ' +
      'problem, and the operator is sent to a share dialog for a key that was never going ' +
      'to work (#132).'
    const { minter, drive } = googleAnswering({ token: () => ({ status: 401, body: {} }) })

    await expect(minter.depot(), why).rejects.toThrow(DocumentRefused)
    expect(drive(), why).toEqual([])
  })
})

describe('a Depot roma cannot write into', () => {
  it('says the id may be wrong or the account may never have been added', async () => {
    const { minter } = googleAnswering({
      depot: () => ({
        status: 404,
        body: {
          error: {
            code: 404,
            message: `File not found: ${DEPOT}.`,
            errors: [{ reason: 'notFound' }],
          },
        },
      }),
    })

    await expect(minter.depot()).rejects.toThrow(DepotUnreachable)
    await expect(minter.depot()).rejects.toThrow(/could not find the Depot/)
    await expect(minter.depot()).rejects.toThrow(/never added to the shared drive/)
    await expect(minter.depot()).rejects.toThrow(DEPOT)
    await expect(minter.depot()).rejects.toThrow(ACCOUNT)
  })

  it('passes on what Drive said when it refused for any other reason', async () => {
    const { minter } = googleAnswering({
      depot: () => ({
        status: 403,
        body: {
          error: {
            code: 403,
            message: 'The user does not have sufficient permissions for this file.',
            errors: [{ reason: 'insufficientFilePermissions' }],
          },
        },
      }),
    })

    await expect(minter.depot()).rejects.toThrow(DepotUnreachable)
    await expect(minter.depot()).rejects.toThrow(/403/)
    await expect(minter.depot()).rejects.toThrow(/insufficientFilePermissions/)
  })

  it('says it is a Viewer where the folder answers and refuses children', async () => {
    const { minter } = googleAnswering({
      depot: () => ({
        body: {
          id: DEPOT,
          name: 'Team documents',
          capabilities: { canAddChildren: false, canEdit: false },
        },
      }),
    })

    await expect(minter.depot()).rejects.toThrow(DepotUnreachable)
    await expect(minter.depot()).rejects.toThrow(/Viewer/)
    await expect(minter.depot()).rejects.toThrow(/Contributor/)
  })

  it('refuses an answer that says nothing about capabilities at all [fence:documents-unread-capability-is-a-refusal]', async () => {
    const why =
      'The Depot proof must pass only on canAddChildren === true (ADR-0022 §6). An answer ' +
      'with no capabilities in it did not say yes, and reading it as one puts the whole ' +
      'point of the proof behind an optional field (4c71de6, #132).'
    const { minter } = googleAnswering({
      depot: () => ({ body: { id: DEPOT, name: 'Team documents' } }),
    })

    const refused: unknown = await minter.depot().then(
      () => null,
      (error: unknown) => error,
    )

    expect(refused, why).toBeInstanceOf(DepotUnreachable)
  })
})
