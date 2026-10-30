import { createSign } from 'node:crypto'
import type { MintedToken } from '../reach.js'
import { DOCUMENT_DEPOT_VAR } from './env-config.js'
import type { Depot, DocumentMinter } from './depot.js'

/** Enforced by `fence:documents-both-drive-scopes`. */
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
] as const

const SCOPE = SCOPES.join(' ')

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

/** How long the signed assertion is good for. An hour, Google's documented maximum. */
const ASSERTION_LIFETIME_S = 3600

/** Enforced by `fence:documents-assertion-is-backdated`. */
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
 * The Depot is not somewhere this identity can put a file. The message says
 * which of the ways that can be true, so an operator knows whether to fix a
 * folder id, a share dialog, or a role.
 */
export class DepotUnreachable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DepotUnreachable'
  }
}

export interface GoogleDocumentMinterOptions {
  /** `client_email`, off the key. */
  readonly account: string
  /** The key's private half, PEM. */
  readonly privateKey: string
  /** The key file's `token_uri`. */
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
 * Caches nothing: refreshing, single-flight and discarding are `FreshTokens`'.
 * Shares no exchange with `GoogleCloudMinter`. Enforced by
 * `fence:documents-shares-no-exchange-with-the-cloud`.
 * Enforced by `fence:cloud-google-named-only-where-bound`.
 * Enforced by `fence:documents-never-resolves-a-credential`.
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
      // Enforced by `fence:documents-unreadable-lifetime-is-spent`.
      expiresAt:
        typeof lifetimeS === 'number' && Number.isFinite(lifetimeS)
          ? this.#now() + lifetimeS * 1000
          : this.#now(),
    }
  }

  /**
   * The Depot, if this identity can see it and add to it, or `DepotUnreachable`.
   * A snapshot at the moment of asking: access lost afterwards is a 403 inside
   * somebody's Turn.
   *
   * It mints its own token rather than being handed one.
   * Enforced by `fence:documents-depot-mints-its-own-token`.
   */
  async depot(): Promise<Depot> {
    const { token } = await this.mint()
    const asked = `${DRIVE_FILES}/${encodeURIComponent(this.#depot)}?fields=id,name,capabilities&supportsAllDrives=true`
    const response = await this.#fetch(asked, {
      headers: { authorization: `Bearer ${token}` },
    })

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
    // Enforced by `fence:documents-unread-capability-is-a-refusal`.
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

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}
