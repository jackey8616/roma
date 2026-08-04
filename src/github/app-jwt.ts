import { createSign } from 'node:crypto'

/**
 * How long a JWT roma signs is good for.
 *
 * Nine against a documented maximum of ten, measured from `iat`: a span GitHub
 * reads as over ten minutes is refused outright, and a credential used for one
 * request loses nothing by the margin.
 *
 * Unverified — GitHub's documented behaviour, and nothing here has driven a real
 * App (`docs/github-app-verification.md`).
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
  // Measured from `iat`, not from now. GitHub validates the *span* — `exp` more
  // than ten minutes after `iat` is refused — so adding the backdating back in
  // here would put the span at exactly 600 seconds, on the boundary, with the
  // margin below spent rather than held.
  const payload = { iat: issuedAt, exp: issuedAt + LIFETIME_S, iss: appId }

  const signed = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = createSign('RSA-SHA256').update(signed).sign(privateKey)
  return `${signed}.${base64url(signature)}`
}

/** base64url, which is base64 with two characters swapped and the padding gone. */
function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}
