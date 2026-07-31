import { generateKeyPairSync, createPublicKey, createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CloudRefused, GoogleCloudMinter } from './google-cloud-minter.js'

/**
 * The Minter, against a fake of Google's token endpoint.
 *
 * `fetch` is the seam, which is the narrowest one available and the same one
 * `src/github/github-minter.test.ts` uses: everything above it — what is signed,
 * what is asked for, what a refusal becomes, how an expiry is read — is roma's,
 * and everything below it is a network this test must not touch and CI must not
 * have a key for.
 *
 * What it cannot assert, and does not pretend to: that Google actually behaves
 * this way. Every response here is written from documentation, and only a real
 * service account can settle it — ADR-0015 is explicit that no Cloud Reach has
 * ever existed. What *was* measured is that this endpoint answers a
 * credential-shaped request at all, with `invalid_request` to a deliberately bad
 * one.
 */

const KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const ACCOUNT = 'agent@a-project.iam.gserviceaccount.com'
const ENDPOINT = 'https://oauth2.example.test/token'
const NOW = Date.parse('2026-07-31T12:00:00Z')

interface Exchange {
  readonly url: string
  readonly method: string
  readonly contentType: string
  readonly form: URLSearchParams
}

/** A token endpoint that answers from a script, and records what it was asked. */
function googleAnswering(reply: () => { status?: number; body: unknown }) {
  const exchanges: Exchange[] = []
  const fetch: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    exchanges.push({
      url: String(input),
      method: init?.method ?? 'GET',
      contentType: headers.get('content-type') ?? '',
      form: new URLSearchParams(String(init?.body ?? '')),
    })
    const { status = 200, body } = reply()
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'text/json' } }),
    )
  }
  return {
    exchanges,
    minter: new GoogleCloudMinter({
      account: ACCOUNT,
      privateKey: PEM,
      tokenEndpoint: ENDPOINT,
      fetch,
      now: () => NOW,
    }),
  }
}

const A_TOKEN = () => ({ body: { access_token: 'ya29.a-token', expires_in: 3599, token_type: 'Bearer' } })

/** The assertion, read back apart from its signature. */
function claimsOf(assertion: string): Record<string, unknown> {
  const payload = assertion.split('.')[1] ?? ''
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('exchanging the key for a Cloud Token', () => {
  it('reports the token and when Google says it dies', async () => {
    const { minter } = googleAnswering(A_TOKEN)

    expect(await minter.mint()).toEqual({
      token: 'ya29.a-token',
      expiresAt: NOW + 3599 * 1000,
    })
  })

  it('posts a signed assertion to the endpoint the key named', async () => {
    const { minter, exchanges } = googleAnswering(A_TOKEN)

    await minter.mint()

    const exchange = exchanges[0]
    expect(exchange?.url).toBe(ENDPOINT)
    expect(exchange?.method).toBe('POST')
    expect(exchange?.contentType).toBe('application/x-www-form-urlencoded')
    expect(exchange?.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
  })

  // The scope is a constant and not a setting (ADR-0015 §5). `cloud-platform`
  // means "whatever the roles allow", which is the Cloud Reach's definition —
  // and nothing here takes a scope, so no caller has a way to ask for a wider
  // credential than the deployment intended.
  it('asks for cloud-platform, every time, with no way to ask for anything else', async () => {
    const { minter, exchanges } = googleAnswering(A_TOKEN)

    await minter.mint()
    await minter.mint()

    for (const exchange of exchanges) {
      const claims = claimsOf(exchange.form.get('assertion') ?? '')
      expect(claims['scope']).toBe('https://www.googleapis.com/auth/cloud-platform')
    }
  })

  it('signs as the account, for the endpoint it is being sent to', async () => {
    const { minter, exchanges } = googleAnswering(A_TOKEN)

    await minter.mint()

    const claims = claimsOf(exchanges[0]?.form.get('assertion') ?? '')
    expect(claims['iss']).toBe(ACCOUNT)
    expect(claims['aud']).toBe(ENDPOINT)
  })

  // A clock a few seconds fast issues an assertion "in the future", which is
  // rejected — and would present as roma failing to mint on a machine that is
  // otherwise working perfectly. The same minute `appJwt` backdates by.
  it('backdates the assertion rather than issuing it exactly now', async () => {
    const { minter, exchanges } = googleAnswering(A_TOKEN)

    await minter.mint()

    const claims = claimsOf(exchanges[0]?.form.get('assertion') ?? '')
    expect(claims['iat']).toBe(Math.floor(NOW / 1000) - 60)
    expect(claims['exp']).toBe(Math.floor(NOW / 1000) - 60 + 3600)
  })

  it('is signed with the private key, RS256', async () => {
    const { minter, exchanges } = googleAnswering(A_TOKEN)
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
  // proof exists to catch, so the refusal has to carry what Google said rather
  // than becoming a bare failure.
  it('carries Google’s refusal, with what it answered', async () => {
    const { minter } = googleAnswering(() => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' },
    }))

    await expect(minter.mint()).rejects.toThrow(CloudRefused)
    await expect(minter.mint()).rejects.toThrow(/400.*Invalid JWT Signature/s)
  })

  // Guessing an hour is the one direction that cannot be walked back: the whole
  // protection here is the credential's lifetime, and a token roma believes in
  // for longer than it is good for is what the caching must not produce.
  it('treats a token with an unreadable lifetime as already spent', async () => {
    const { minter } = googleAnswering(() => ({
      body: { access_token: 'ya29.a-token', expires_in: 'about an hour' },
    }))

    expect((await minter.mint()).expiresAt).toBe(NOW)
  })

  // A 200 with nothing usable in it. Better as a refusal here than as an empty
  // Authorization header several steps away, inside somebody's Turn.
  it('refuses an answer with no token in it', async () => {
    const { minter } = googleAnswering(() => ({ body: { token_type: 'Bearer' } }))

    await expect(minter.mint()).rejects.toThrow(/without an access token/)
  })
})
