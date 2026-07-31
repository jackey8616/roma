import { createSign } from 'node:crypto'
import type { CloudMinter, MintedToken } from '../minter.js'

/**
 * What a Cloud Token is scoped to, every time, for everybody.
 *
 * A constant and not a setting (ADR-0015 §5). `cloud-platform` means "whatever
 * the roles allow", which is the Cloud Reach's definition — the boundary is
 * meant to be the IAM roles, visible to whoever deployed roma and auditable in
 * Google's own console. A configurable scope would be a second boundary,
 * invisible from there, whose failures present as "roma is broken" rather than
 * as "that scope is narrow". There is deliberately no environment variable for
 * it, and a caller cannot ask for a wider one because nothing takes a scope.
 */
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

/**
 * How far into the past `iat` is set.
 *
 * The same minute `appJwt` backdates by, for the same reason: a clock a few
 * seconds fast issues an assertion "in the future", which is rejected — and
 * would present as roma failing to mint on a machine that is otherwise working
 * perfectly.
 */
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
  /** The identity's own name for itself. `client_email`, off the key. */
  readonly account: string
  /** The key's private half, PEM. Read from a file by `readCloudEnv`. */
  readonly privateKey: string
  /** Where the exchange happens. The key file's `token_uri`. */
  readonly tokenEndpoint: string
  /** Injected so that every decision here can be asserted without a network. */
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

/**
 * The only thing in roma that holds the Cloud Reach's key.
 *
 * Everything it does is one documented exchange with a signed assertion in front
 * of it, and it caches nothing: refreshing before expiry, serving concurrent
 * askers from one mint and discarding a rejected token are `FreshTokens`',
 * which is arithmetic rather than product knowledge and is tested against a fake
 * of the port.
 *
 * Signed here rather than with a library, exactly as `appJwt` is and for the
 * same reason: the whole of it is three base64url segments and one RS256
 * signature, and a dependency that reaches a private key is a dependency
 * somebody has to keep reading. `google-auth-library` is installed and could do
 * this — what it *also* does is resolve a credential when it is not handed one,
 * and that chain ends at the metadata server. Handing it a key explicitly would
 * work today and would put the resolution path one edit away forever.
 *
 * **The key never leaves this object.** What the agent is handed expires within
 * the hour, which is the whole of what ADR-0015 buys: the agent can narrow what
 * it was given and can never widen it, because widening needs the key.
 *
 * It is **not** out of the agent's reach, and neither is the App's PEM — the key
 * is a file mounted into the container roma runs in, the agent's Claude Code
 * process is a child of roma's, and they share a uid. `github-minter.ts` records
 * that gap for the other provider and it is the same gap here.
 *
 * **Nothing here has been measured.** Every behaviour it relies on is Google's
 * documentation and not this repository's observation — no Cloud Reach has ever
 * existed (ADR-0015, Verification status). The one thing that *was* measured is
 * that this endpoint answers a credential-shaped request at all.
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
      // A token whose lifetime roma cannot read is treated as expiring now, so
      // it is used once and never cached — `GitHubMinter`'s rule, for its
      // reason. The whole protection here is the credential's lifetime, and
      // guessing it long is the one direction that cannot be walked back.
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

/** base64url, which is base64 with two characters swapped and the padding gone. */
function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}
