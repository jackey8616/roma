import { generateKeyPairSync, createPublicKey, createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CloudRefused, GoogleCloudMinter } from './google-cloud-minter.js'

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

const A_TOKEN = () => ({
  body: { access_token: 'ya29.a-token', expires_in: 3599, token_type: 'Bearer' },
})

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

  it('backdates the assertion rather than issuing it exactly now [fence:cloud-assertion-is-backdated]', async () => {
    const why =
      'The assertion is issued a minute in the past (ADR-0015). A clock a few seconds fast ' +
      'issues one "in the future", Google rejects it, and roma fails to mint on a machine ' +
      'that is otherwise working perfectly (#99).'
    const { minter, exchanges } = googleAnswering(A_TOKEN)

    await minter.mint()

    const claims = claimsOf(exchanges[0]?.form.get('assertion') ?? '')
    expect(claims['iat'], why).toBe(Math.floor(NOW / 1000) - 60)
    expect(claims['exp'], why).toBe(Math.floor(NOW / 1000) - 60 + 3600)
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

  it('carries Google’s refusal, with what it answered', async () => {
    const { minter } = googleAnswering(() => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' },
    }))

    await expect(minter.mint()).rejects.toThrow(CloudRefused)
    await expect(minter.mint()).rejects.toThrow(/400.*Invalid JWT Signature/s)
  })

  it('treats a token with an unreadable lifetime as already spent [fence:cloud-unreadable-lifetime-is-spent]', async () => {
    const why =
      'A Cloud Token whose lifetime cannot be read expires now: used once, never cached ' +
      "(ADR-0015: the whole protection is the credential's lifetime). Guessing it long is the " +
      'one direction that cannot be walked back — a token cached past its real life (#99).'
    const { minter } = googleAnswering(() => ({
      body: { access_token: 'ya29.a-token', expires_in: 'about an hour' },
    }))

    expect((await minter.mint()).expiresAt, why).toBe(NOW)
  })

  it('refuses an answer with no token in it', async () => {
    const { minter } = googleAnswering(() => ({ body: { token_type: 'Bearer' } }))

    await expect(minter.mint()).rejects.toThrow(/without an access token/)
  })
})
