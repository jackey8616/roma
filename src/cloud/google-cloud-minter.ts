import { createSign } from 'node:crypto'
import type { MintedToken, MintsTokens } from '../reach.js'

/** A Minter that also knows which identity its tokens act as. */
export interface CloudMinter extends MintsTokens {
  /** How the identity names itself, as an operator would recognise it. */
  readonly account: string
}

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/**
 * The grant that says "here is a signed assertion, give me a token".
 *
 * The half of the exchange that is not the assertion. Google's own name for it,
 * and an IETF one rather than a Google one, which is why it is spelled out here
 * rather than described.
 */
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

/**
 * How long the signed assertion is good for.
 *
 * An hour, which is Google's documented maximum. It is exchanged immediately and
 * never held, so the number governs nothing but the clock skew roma tolerates —
 * the credential that matters is what comes back, and how long *that* lasts is
 * Google's answer rather than this one.
 */
const ASSERTION_LIFETIME_S = 3600

/** Enforced by `fence:cloud-assertion-is-backdated`. */
const BACKDATED_S = 60

/** Google answered, and the answer was not one roma can use. */
export class CloudRefused extends Error {
  readonly status: number

  constructor(status: number, body: string) {
    super(`Google refused to mint a Cloud Token, with ${String(status)}: ${body.slice(0, 400)}`)
    this.name = 'CloudRefused'
    this.status = status
  }
}

export interface GoogleCloudMinterOptions {
  /** `client_email`, off the key. */
  readonly account: string
  /** The key's private half, PEM. */
  readonly privateKey: string
  /** The key file's `token_uri`. */
  readonly tokenEndpoint: string
  /** Injected so that every decision here can be asserted without a network. */
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

/**
 * The only thing in roma that holds the Cloud Reach's key.
 *
 * Caches nothing: refreshing, single-flight and discarding are `FreshTokens`'.
 * Enforced by `fence:cloud-never-resolves-a-credential`.
 */
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

  /** One Cloud Token, scoped as every other one is. */
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
      // Enforced by `fence:cloud-unreadable-lifetime-is-spent`.
      expiresAt:
        typeof lifetimeS === 'number' && Number.isFinite(lifetimeS)
          ? this.#now() + lifetimeS * 1000
          : this.#now(),
    }
  }

  /**
   * The signed thing that is exchanged for a token.
   *
   * Never cached and never handed to anything: it exists for one request, inside
   * the Minter, which is the only thing that holds the key at all.
   */
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
