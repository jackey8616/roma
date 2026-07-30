import { createSign } from 'node:crypto'

/**
 * How long a JWT roma signs is good for.
 *
 * Nine minutes against a documented maximum of ten. The margin is for clock
 * drift in the same direction as `BACKDATED_S` below: a token whose `exp` GitHub
 * reads as more than ten minutes away is refused outright, and losing a minute
 * of a credential that is only ever used for one request costs nothing.
 *
 * Unverified here — this is GitHub's documented behaviour and nothing in this
 * repository has driven a real App (`docs/github-app-verification.md`).
 */
const LIFETIME_S = 9 * 60

/**
 * How far into the past `iat` is set.
 *
 * GitHub's own guidance, and the reason is a clock that is a few seconds fast:
 * a JWT issued "in the future" is rejected, which would present as roma failing
 * to mint on a machine that is otherwise working perfectly.
 */
const BACKDATED_S = 60

export interface AppJwtOptions {
  /** The GitHub App's id, which is what it signs as. */
  readonly appId: string
  /** The App's private key, PEM as GitHub issued it. */
  readonly privateKey: string
  /** Epoch milliseconds. Injected so the arithmetic can be asserted on. */
  readonly now?: number
}

/**
 * A JWT the App can exchange for an Installation Token.
 *
 * Signed here rather than with a library because the whole of it is three
 * base64url segments and one RS256 signature, and a dependency that reaches a
 * private key is a dependency somebody has to keep reading. `node:crypto` does
 * the only hard part.
 *
 * The result is never cached and never handed to anything: it exists for one
 * request, inside the Minter, which is the only thing that holds the key at all.
 */
export function appJwt({ appId, privateKey, now = Date.now() }: AppJwtOptions): string {
  const issuedAt = Math.floor(now / 1000) - BACKDATED_S
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = { iat: issuedAt, exp: issuedAt + BACKDATED_S + LIFETIME_S, iss: appId }

  const signed = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = createSign('RSA-SHA256').update(signed).sign(privateKey)
  return `${signed}.${base64url(signature)}`
}

/** base64url, which is base64 with two characters swapped and the padding gone. */
function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}
