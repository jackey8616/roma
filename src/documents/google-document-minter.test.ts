import { generateKeyPairSync, createPublicKey, createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DepotUnreachable, DocumentRefused, GoogleDocumentMinter } from './google-document-minter.js'

/**
 * The Minter, against a fake of Google's token endpoint and of Drive.
 *
 * `fetch` is the seam, which is the narrowest one available and the same one
 * `src/cloud/google-cloud-minter.test.ts` and `src/github/github-minter.test.ts`
 * use: everything above it — what is signed, what is asked for, what a refusal
 * becomes, how a capability is read — is roma's, and everything below it is a
 * network this test must not touch and CI must not have a key for.
 *
 * **Every fixture below is written from Google's documentation, and nothing in
 * it has been measured.** That is the same footing `google-cloud-minter.test.ts`
 * stands on and it is stated here for the same reason ADR-0015's Verification
 * status states it: no Document Reach has ever existed, no service account has
 * ever been made, no shared drive has ever been shared with one, and
 * `docs/document-reach-verification.md` — the run ADR-0022's spec asks for
 * before any of this — has not happened. So these responses are what Google
 * *says* it answers with:
 *
 * - the JWT-bearer exchange, its form encoding and its `expires_in`;
 * - `files.get` answering `id`, `name` and `capabilities` under `fields`, and
 *   needing `supportsAllDrives` to see a shared drive at all;
 * - `capabilities.canAddChildren` being the answer to "may this identity put
 *   something in this folder";
 * - `notFound` covering both a folder that is not there and a folder this
 *   identity was never given.
 *
 * ADR-0015 was written in exactly this position and **was reversed twice by
 * measurement inside one session**. Read ADR-0022's Verification status before
 * trusting any assertion here as a fact about Google rather than as a fact about
 * roma. What these tests genuinely establish is the half that is roma's: that
 * one scope constant reaches the assertion, that the boot proof asks the
 * question it claims to ask, and that three different answers produce three
 * different sentences for an operator to act on.
 */

const KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const ACCOUNT = 'writer@a-project.iam.gserviceaccount.com'
const ENDPOINT = 'https://oauth2.example.test/token'
const DEPOT = 'FOLDER_ID'
const NOW = Date.parse('2026-08-03T12:00:00Z')

/** Both scopes, in the order the constant lists them, and nothing else. */
const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly'

interface Exchange {
  readonly url: string
  readonly method: string
  readonly contentType: string
  readonly authorization: string
  readonly form: URLSearchParams
}

type Answer = { status?: number; body: unknown }

/** What the token endpoint answers with, per Google's documentation of the exchange. */
const A_TOKEN = (): Answer => ({
  body: { access_token: 'ya29.a-token', expires_in: 3599, token_type: 'Bearer' },
})

/**
 * A folder in a shared drive, as `files.get` documents the projection.
 *
 * `capabilities` carries far more fields than these; the three here are the one
 * the proof reads and the two that say what ADR-0022 §5's role table claims a
 * Contributor is — which is the table most likely to be wrong, and the reason
 * this fixture spells them out rather than only the field roma looks at.
 */
const A_DEPOT = (): Answer => ({
  body: {
    id: DEPOT,
    name: 'Team documents',
    capabilities: { canAddChildren: true, canEdit: true, canTrash: false, canDelete: false },
  },
})

/** Google and Drive answering from a script, recording what they were asked. */
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
    /** Everything asked of Drive, which is everything that was not the exchange. */
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

/** The assertion, read back apart from its signature. */
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

  // The scope is two constants and not a setting (ADR-0022 §3). Asserted as an
  // exact string rather than as two `toContain`s, because "and neither more" is
  // half the claim: a scope a deployment could widen would be a second boundary,
  // invisible from where the first one is administered, and nothing here takes a
  // scope so no caller can ask for a wider credential than was intended.
  it('asks for both Drive scopes and neither more, every time', async () => {
    const { minter, exchanges } = googleAnswering()

    await minter.mint()
    await minter.mint()

    for (const exchange of exchanges) {
      const claims = claimsOf(exchange.form.get('assertion') ?? '')
      expect(claims['scope']).toBe(SCOPES)
    }
  })

  // Neither `spreadsheets` nor `documents`, which is what makes "the team wants
  // both formats" cost no extra scope: `drive.file` covers the Docs API and the
  // Sheets API for files the app created. Read from Google's documentation, and
  // the single most valuable thing a real run would confirm.
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

  // A clock a few seconds fast issues an assertion "in the future", which is
  // rejected — and would present as roma failing to mint on a machine that is
  // otherwise working perfectly.
  it('backdates the assertion rather than issuing it exactly now', async () => {
    const { minter, exchanges } = googleAnswering()

    await minter.mint()

    const claims = claimsOf(exchanges[0]?.form.get('assertion') ?? '')
    expect(claims['iat']).toBe(Math.floor(NOW / 1000) - 60)
    expect(claims['exp']).toBe(Math.floor(NOW / 1000) - 60 + 3600)
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

  // A key that is syntactically perfect and revoked is exactly what the boot
  // proof exists to catch, so the refusal carries what Google said rather than
  // becoming a bare failure.
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

  // Guessing an hour is the one direction that cannot be walked back: the whole
  // protection here is the credential's lifetime, and a token roma believes in
  // for longer than it is good for is what the caching must not produce.
  it('treats a token with an unreadable lifetime as already spent', async () => {
    const { minter } = googleAnswering({
      token: () => ({ body: { access_token: 'ya29.a-token', expires_in: 'about an hour' } }),
    })

    expect((await minter.mint()).expiresAt).toBe(NOW)
  })

  it('refuses an answer with no token in it', async () => {
    const { minter } = googleAnswering({ token: () => ({ body: { token_type: 'Bearer' } }) })

    await expect(minter.mint()).rejects.toThrow(/without an access token/)
  })
})

describe('proving the Depot is somewhere this identity can write', () => {
  // The half of the boot proof that is new to roma: every other proof it makes
  // says a credential is *live*, and this one says a permission is there
  // (ADR-0022 §6). Both parameters are the claim — `fields` because
  // `capabilities` is not in the default projection, and `supportsAllDrives`
  // because the Depot has to be in a shared drive and without it this is a My
  // Drive call.
  it('asks for the folder’s capabilities, in a form that works on a shared drive', async () => {
    const { minter, drive } = googleAnswering()

    await minter.depot()

    const asked = drive()[0]?.url ?? ''
    expect(asked).toContain(`/drive/v3/files/${DEPOT}`)
    expect(asked).toContain('fields=id,name,capabilities')
    expect(asked).toContain('supportsAllDrives=true')
  })

  // It mints its own credential rather than being handed one, which is what keeps
  // the Reach from ever holding a token: the Minter is the only thing that holds
  // the key, and proving the folder needs one.
  it('reaches Drive with a token it minted itself', async () => {
    const { minter, drive } = googleAnswering()

    await minter.depot()

    expect(drive()[0]?.authorization).toBe('Bearer ya29.a-token')
  })

  it('reports the folder as Drive named it', async () => {
    const { minter } = googleAnswering()

    expect(await minter.depot()).toEqual({ id: DEPOT, name: 'Team documents' })
  })

  // A key that cannot mint has nothing to reach Drive with, and the refusal
  // should be about the key. Asserted as "Drive was never asked" because that is
  // what stops an operator being sent to a share dialog for a revoked key.
  it('does not ask Drive anything when the key cannot mint', async () => {
    const { minter, drive } = googleAnswering({ token: () => ({ status: 401, body: {} }) })

    await expect(minter.depot()).rejects.toThrow(DocumentRefused)
    expect(drive()).toEqual([])
  })
})

/**
 * **The most valuable test in this file** (ADR-0022's spec says so, and §6 is
 * the argument): a Depot named by a typo, a shared drive the account was never
 * added to, and an account added as a Viewer are three different mistakes, and
 * an operator has to be told which one they made — whether to fix an id, a share
 * dialog, or a role.
 *
 * Two of those three arrive from Drive as one status, and that is documented
 * rather than chosen: a file this identity cannot see does not exist as far as
 * the API is concerned, so `notFound` covers both. The sentence names both fixes
 * instead of guessing. Unmeasured, like everything else here.
 */
describe('a Depot roma cannot write into', () => {
  it('says the id may be wrong or the account may never have been added', async () => {
    const { minter } = googleAnswering({
      depot: () => ({
        status: 404,
        body: { error: { code: 404, message: `File not found: ${DEPOT}.`, errors: [{ reason: 'notFound' }] } },
      }),
    })

    await expect(minter.depot()).rejects.toThrow(DepotUnreachable)
    await expect(minter.depot()).rejects.toThrow(/could not find the Depot/)
    await expect(minter.depot()).rejects.toThrow(/never added to the shared drive/)
    // The id and the identity, because between them they are the whole of what
    // an operator has to go and compare.
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

  // The permission that looks configured and does not work, which is the mistake
  // this half of the proof was added for: somebody completed the share dialog and
  // picked the wrong role. Named as a Viewer rather than described, because that
  // is the word in the dialog they have to go back to.
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

  // Positive or refused. An answer roma could not read the permission out of is
  // an answer that did not say yes, and treating it as one would put the whole
  // point of this proof behind an optional field.
  it('refuses an answer that says nothing about capabilities at all', async () => {
    const { minter } = googleAnswering({ depot: () => ({ body: { id: DEPOT, name: 'Team documents' } }) })

    await expect(minter.depot()).rejects.toThrow(DepotUnreachable)
  })
})
