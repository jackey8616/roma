import { createSign } from 'node:crypto'
import type { MintedToken, MintsTokens } from '../reach.js'

export interface CloudMinter extends MintsTokens {
  readonly account: string
}

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

const ASSERTION_LIFETIME_S = 3600

const BACKDATED_S = 60

export class CloudRefused extends Error {
  readonly status: number

  constructor(status: number, body: string) {
    super(`Google refused to mint a Cloud Token, with ${String(status)}: ${body.slice(0, 400)}`)
    this.name = 'CloudRefused'
    this.status = status
  }
}

export interface GoogleCloudMinterOptions {
  readonly account: string
  readonly privateKey: string
  readonly tokenEndpoint: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export class GoogleCloudMinter implements CloudMinter {
  readonly account: string
  readonly #privateKey: string
  readonly #tokenEndpoint: string
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number

  constructor({
    account,
    privateKey,
    tokenEndpoint,
    fetch = globalThis.fetch,
    now = Date.now,
  }: GoogleCloudMinterOptions) {
    this.account = account
    this.#privateKey = privateKey
    this.#tokenEndpoint = tokenEndpoint
    this.#fetch = fetch
    this.#now = now
  }

  async mint(): Promise<MintedToken> {
    const response = await this.#fetch(this.#tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: GRANT_TYPE,
        assertion: this.#assertion(),
      }).toString(),
    })
    if (!response.ok) throw new CloudRefused(response.status, await response.text())

    const minted = (await response.json()) as { access_token?: unknown; expires_in?: unknown }
    const token = minted.access_token
    if (typeof token !== 'string' || token === '') {
      throw new Error('Google answered the token exchange without an access token in it.')
    }

    const lifetimeS = minted.expires_in
    return {
      token,
      expiresAt:
        typeof lifetimeS === 'number' && Number.isFinite(lifetimeS)
          ? this.#now() + lifetimeS * 1000
          : this.#now(),
    }
  }

  #assertion(): string {
    const issuedAt = Math.floor(this.#now() / 1000) - BACKDATED_S
    const header = { alg: 'RS256', typ: 'JWT' }
    const claims = {
      iss: this.account,
      scope: SCOPE,
      aud: this.#tokenEndpoint,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_S,
    }

    const signed = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
    const signature = createSign('RSA-SHA256').update(signed).sign(this.#privateKey)
    return `${signed}.${base64url(signature)}`
  }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}
