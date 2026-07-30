/**
 * The whole of what the Core knows about reaching anybody's code.
 *
 * A port, and a narrow one on purpose. Everything that knows which forge this is
 * — the App id, the private key, the JWT, the REST calls — lives under
 * `src/github/`, and `src/github-containment.test.ts` is what keeps it there.
 * The justification is the testing seam rather than a second forge nobody has
 * asked for: behind this, `wiring.test.ts` can still assemble roma out of real
 * parts, and the free run stays free.
 */

/**
 * One Installation Token, and the moment it stops being one.
 *
 * The expiry rides along rather than being inferred from a lifetime constant,
 * because how long a token lasts is the forge's answer and not roma's — roma
 * refreshes against what it was told, so a provider that shortens the hour
 * shortens roma's clock with it.
 */
export interface MintedToken {
  readonly token: string
  /** Epoch milliseconds, as the forge reported it. */
  readonly expiresAt: number
}

/**
 * What roma can reach, and who it is acting as.
 *
 * The whole of the boundary, which is why it is a value roma holds rather than
 * a question it asks per request: every Conversation reaches all of this, and so
 * does everyone who can message roma (ADR-0008).
 */
export interface Installation {
  /** How the Installation names itself — an organisation, or a person. */
  readonly account: string
  /** Every repository it reaches, `owner/name`. */
  readonly repositories: readonly string[]
}

/**
 * The only thing that holds the App's private key.
 *
 * Two operations, and they are asked at opposite ends of roma's life. Startup
 * asks for the Installation, once, and blocks the boot if the answer does not
 * come — a bad key that surfaced instead as an inexplicable `git clone` failure
 * inside somebody's Turn would read as "roma is broken" with no diagnosis
 * attached. Everything after that asks only for tokens.
 *
 * Neither method caches. Refreshing before expiry, serving concurrent askers
 * from one mint, and discarding a token the forge rejected are all
 * `InstallationTokens`' — decisions about arithmetic and timing rather than
 * about a product, and they are tested against a fake of this.
 */
export interface Minter {
  /** Prove roma can reach its Installation, and report what it reaches. */
  installation(): Promise<Installation>
  /** A fresh Installation Token, for the whole Installation. */
  mint(): Promise<MintedToken>
}
