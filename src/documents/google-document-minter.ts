import { createSign } from 'node:crypto'
import type { MintedToken } from '../reach.js'
import { DOCUMENT_DEPOT_VAR } from './env-config.js'
import type { Depot, DocumentMinter } from './depot.js'

/**
 * What a Document Token is scoped to, every time, for everybody.
 *
 * Two constants and not a setting (ADR-0022 §3, on ADR-0015 §5's argument): a
 * scope a deployment could widen is a second boundary, invisible from where the
 * first one is administered. Nothing here takes a scope from outside, and no
 * caller has a way to ask for a wider credential than the deployment intended.
 *
 * `drive.file` is **per-file**: it reaches what this app created and nothing
 * else, which is the whole of the write side and is enough for both a Doc and a
 * Sheet, because the Docs API and the Sheets API each accept it for files the
 * app created. That is also what makes the write side immune to somebody in the
 * organisation sharing a document with this identity — `drive.file` does not
 * care what was shared, only what was created.
 *
 * `drive.readonly` is the read side and does **not** have that property: it
 * reaches everything shared with the account. It is here for two things, and the
 * second is invisible from the code that would delete it — somebody may leave
 * reference material in the Depot, and **the boot proof depends on it**. The
 * Depot folder was not created by this app, so `drive.file` cannot read it.
 * Removing this line as unused removes `depot()` below with it, and the finding
 * out happens at the next deployment rather than at the edit (ADR-0022 §3).
 */
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
] as const

/** The two, as one claim, which is how the exchange wants them. */
const SCOPE = SCOPES.join(' ')

/**
 * The grant that says "here is a signed assertion, give me a token".
 *
 * Google's own name for it, and an IETF one rather than a Google one — spelled
 * out here rather than shared with `src/cloud/`, because a factory in a
 * directory no containment rule binds would be a way to construct a Google
 * credential from outside one (ADR-0022's spec, and ADR-0020 §7 before it).
 */
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

/** How long the signed assertion is good for. An hour, Google's documented maximum. */
const ASSERTION_LIFETIME_S = 3600

/**
 * How far into the past `iat` is set.
 *
 * The same minute `appJwt` and `GoogleCloudMinter` backdate by, for the same
 * reason: a clock a few seconds fast issues an assertion "in the future", which
 * is rejected — and would present as roma failing to mint on a machine that is
 * otherwise working perfectly.
 */
const BACKDATED_S = 60

/** Where Drive's files live. The v3 REST API, which is what the image can speak. */
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'

/** Google answered the token exchange, and the answer was not one roma can use. */
export class DocumentRefused extends Error {
  readonly status: number

  constructor(status: number, body: string) {
    super(`Google refused to mint a Document Token, with ${String(status)}: ${body.slice(0, 400)}`)
    this.name = 'DocumentRefused'
    this.status = status
  }
}

/**
 * The Depot is not somewhere this identity can put a file, and here is which of
 * the ways that can be true.
 *
 * One class carrying three different sentences rather than three classes,
 * because nothing branches on which: what an operator needs is to be told
 * whether to fix a folder id, a share dialog, or a role (ADR-0022 §6), and the
 * sentence is the whole of that.
 */
export class DepotUnreachable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DepotUnreachable'
  }
}

export interface GoogleDocumentMinterOptions {
  /** The identity's own name for itself. `client_email`, off the key. */
  readonly account: string
  /** The key's private half, PEM. Read from a file by `readDocumentEnv`. */
  readonly privateKey: string
  /** Where the exchange happens. The key file's `token_uri`. */
  readonly tokenEndpoint: string
  /** The Depot's folder id, as the deployment named it. */
  readonly depot: string
  /** Injected so that every decision here can be asserted without a network. */
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

/**
 * The only thing in roma that holds the Document Reach's key.
 *
 * One documented exchange with a signed assertion in front of it, and one
 * documented Drive call for the boot proof. It caches nothing: refreshing before
 * expiry, serving concurrent askers from one mint and discarding a rejected
 * token are `FreshTokens`', which is arithmetic rather than product knowledge.
 *
 * **Written twice rather than shared with `GoogleCloudMinter`, deliberately.**
 * The two exchanges are the same shape, and the sharing that would remove the
 * duplication is the sharing ADR-0022 forbids: nothing may make it possible to
 * construct a Google credential from outside a directory a containment rule
 * binds, and neither directory may take its scope from anywhere but its own
 * constant. ADR-0020 §7 moved the cloud's construction *inside* its own
 * directory precisely so the rule would bind the construction site; a factory in
 * a directory no rule binds would undo that for both of them. This repository
 * has paid for the general version of that mistake once already.
 *
 * Signed here rather than with a library, exactly as `appJwt` is: the whole of
 * it is three base64url segments and one RS256 signature, and
 * `google-auth-library` — which is installed, for roma's *own* identity —
 * resolves a credential when it is not handed one, and that chain ends at the
 * metadata server.
 *
 * **The key never leaves this object.** What the agent is handed expires within
 * the hour. It is **not** out of the agent's reach, and neither is the App's PEM
 * nor the cloud's key: they are files mounted into the container roma runs in,
 * the agent's Claude Code process is a child of roma's, and they share a uid.
 *
 * **Nothing here has been measured.** Every behaviour it relies on — that this
 * exchange answers, that `drive.file` covers the Docs and the Sheets API on
 * files the app created, that a folder's `capabilities` come back this way on a
 * shared drive — is read out of Google's documentation. ADR-0022's Verification
 * status says so first, for the reason ADR-0015's own history gives: that record
 * was in this exact position and was reversed twice by measurement inside one
 * session.
 */
export class GoogleDocumentMinter implements DocumentMinter {
  readonly account: string
  readonly #privateKey: string
  readonly #tokenEndpoint: string
  readonly #depot: string
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number

  constructor({
    account,
    privateKey,
    tokenEndpoint,
    depot,
    fetch = globalThis.fetch,
    now = Date.now,
  }: GoogleDocumentMinterOptions) {
    this.account = account
    this.#privateKey = privateKey
    this.#tokenEndpoint = tokenEndpoint
    this.#depot = depot
    this.#fetch = fetch
    this.#now = now
  }

  /** One Document Token, scoped as every other one is. */
  async mint(): Promise<MintedToken> {
    const response = await this.#fetch(this.#tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: GRANT_TYPE,
        assertion: this.#assertion(),
      }).toString(),
    })
    if (!response.ok) throw new DocumentRefused(response.status, await response.text())

    const minted = (await response.json()) as { access_token?: unknown; expires_in?: unknown }
    const token = minted.access_token
    if (typeof token !== 'string' || token === '') {
      throw new Error('Google answered the token exchange without an access token in it.')
    }

    const lifetimeS = minted.expires_in
    return {
      token,
      // A token whose lifetime roma cannot read is treated as expiring now, so it
      // is used once and never cached. The whole protection here is the
      // credential's lifetime, and guessing it long is the one direction that
      // cannot be walked back.
      expiresAt:
        typeof lifetimeS === 'number' && Number.isFinite(lifetimeS)
          ? this.#now() + lifetimeS * 1000
          : this.#now(),
    }
  }

  /**
   * The Depot, if this identity can see it and add to it.
   *
   * The half of the boot proof that is new to roma. Every other proof roma makes
   * says a credential is *live*; this one says a permission is there, which
   * ADR-0015 §8 records as the gap on the cloud side — *"it does not prove the
   * Cloud Reach has the roles a Task will need, so permission-denied still
   * surfaces inside a Turn"*. Here it costs one call and a `fields=` parameter.
   *
   * It mints its own token rather than being handed one. Two round trips at
   * boot, and it buys a refusal that names the right thing: a revoked key
   * reported as a Depot problem would send an operator to a share dialog for a
   * key that was never going to work.
   *
   * **It is a snapshot and not a guarantee.** An account removed from the shared
   * drive an hour after boot is a 403 inside somebody's Turn. This narrows the
   * window; it does not close it.
   */
  async depot(): Promise<Depot> {
    const { token } = await this.mint()
    // `supportsAllDrives` because the Depot has to be in a shared drive — the
    // role table the whole design rests on exists only there, and a service
    // account has no Drive storage of its own to own a file against in somebody's
    // My Drive (ADR-0022 §5). Without the parameter the call is a My Drive call.
    // `fields` because the answer roma needs is `capabilities`, which is not in
    // the default projection.
    const asked = `${DRIVE_FILES}/${encodeURIComponent(this.#depot)}?fields=id,name,capabilities&supportsAllDrives=true`
    const response = await this.#fetch(asked, {
      headers: { authorization: `Bearer ${token}` },
    })

    // The two mistakes Drive cannot tell apart, told apart in the refusal
    // instead. A folder that is not there and a folder this identity was never
    // given both answer `notFound` — a file you cannot see does not exist as far
    // as the API is concerned — so the sentence names both fixes rather than
    // guessing which one an operator needs. Read from Google's documentation of
    // `files.get`; unmeasured, like everything else here.
    if (response.status === 404) {
      throw new DepotUnreachable(
        `roma could not find the Depot: ${DOCUMENT_DEPOT_VAR} is "${this.#depot}", and Drive says ` +
          `there is no such folder. Either the id is wrong, or ${this.account} was never added to ` +
          'the shared drive that holds it — Drive answers the same way for both.',
      )
    }
    if (!response.ok) {
      throw new DepotUnreachable(
        `Drive refused roma's request for the Depot "${this.#depot}" as ${this.account}, with ` +
          `${String(response.status)}: ${(await response.text()).slice(0, 400)}`,
      )
    }

    const found = (await response.json()) as {
      id?: unknown
      name?: unknown
      capabilities?: { canAddChildren?: unknown }
    }
    // Positive or refused: an answer with no `capabilities` in it is an answer
    // that did not say yes, and treating "roma could not read the permission" as
    // "the permission is there" would put the whole point of this proof behind an
    // optional field.
    if (found.capabilities?.canAddChildren !== true) {
      throw new DepotUnreachable(
        `roma can see the Depot "${this.#depot}" and cannot add anything to it as ${this.account}. ` +
          'On a shared drive that is what a Viewer looks like — the identity needs to be a ' +
          'Contributor, which may create and edit and may not move, trash or delete.',
      )
    }

    return {
      id: typeof found.id === 'string' && found.id !== '' ? found.id : this.#depot,
      // Named for the agent's benefit rather than roma's, so a folder that
      // answered without one is reported by its id rather than as an empty
      // string. Nothing decides anything by it.
      name: typeof found.name === 'string' && found.name !== '' ? found.name : this.#depot,
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
