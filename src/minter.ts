/**
 * The whole of what the Core knows about reaching anybody's code, and anybody's
 * cloud.
 *
 * Ports, and narrow ones on purpose. Everything that knows which forge this is —
 * the App id, the private key, the JWT, the REST calls — lives under
 * `src/github/`, and `src/github-containment.test.ts` is what keeps it there;
 * everything that knows which cloud this is lives under `src/cloud/`, kept by
 * `src/cloud-containment.test.ts`. The justification is the testing seam rather
 * than a second forge nobody has asked for: behind these, `wiring.test.ts` can
 * still assemble roma out of real parts, and the free run stays free.
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
 * Something that turns a long-lived key into something short-lived.
 *
 * The half of a Minter that both providers have, and the whole of what
 * `FreshTokens` needs — which is why it is a type of its own rather than a
 * comment on a resemblance. The arithmetic that keeps a token fresh is about
 * expiry and concurrency and has no opinion about which credential it is
 * holding, so it is written once against this and reused.
 *
 * It does not cache. Refreshing before expiry, serving concurrent askers from
 * one mint, and discarding a token the provider rejected are all
 * `FreshTokens`' — decisions about arithmetic and timing rather than about a
 * product, and they are tested against a fake of this.
 */
export interface MintsTokens {
  mint(): Promise<MintedToken>
}

/**
 * The only thing that holds the App's private key.
 *
 * Two operations, and they are asked at opposite ends of roma's life. Startup
 * asks for the Installation, once, and blocks the boot if the answer does not
 * come — a bad key that surfaced instead as an inexplicable `git clone` failure
 * inside somebody's Turn would read as "roma is broken" with no diagnosis
 * attached. Everything after that asks only for tokens.
 */
export interface Minter extends MintsTokens {
  /** Prove roma can reach its Installation, and report what it reaches. */
  installation(): Promise<Installation>
  /** A fresh Installation Token, for the whole Installation. */
  mint(): Promise<MintedToken>
}

/**
 * What the agent can touch in the cloud at all, and who it acts as.
 *
 * One identity somebody decided on, and the roles they gave it are the whole of
 * the boundary — the Installation's shape on a second provider. roma holds it as
 * a value rather than asking per request for the reason an Installation is held
 * that way: it is fixed at boot, identical in every Session, and every
 * Conversation reaches all of it.
 *
 * One field, and deliberately no second one. A Cloud Reach reports no inventory
 * of what it reaches — roma is told which identity to hand over and nothing
 * about what that identity may do, so work refused for want of a role is refused
 * by the provider and never by roma (ADR-0015).
 */
export interface CloudReach {
  /** How the identity names itself, as an operator would recognise it. */
  readonly account: string
}

/**
 * The only thing that holds the Cloud Reach's key.
 *
 * The Minter's other half, and one operation rather than two: there is no
 * `installation()` equivalent, because there is no inventory to fetch. What
 * startup wants proved is that the key is live, and minting one token and
 * throwing it away proves exactly that.
 */
export interface CloudMinter extends MintsTokens, CloudReach {}
