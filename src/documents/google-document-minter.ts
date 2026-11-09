import { createSign } from 'node:crypto'
import type { MintedToken } from '../reach.js'
import { DOCUMENT_DEPOT_VAR } from './env-config.js'
import type { Depot, DocumentMinter } from './depot.js'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
] as const

const SCOPE = SCOPES.join(' ')

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

const ASSERTION_LIFETIME_S = 3600

const BACKDATED_S = 60

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'

export class DocumentRefused extends Error {
  readonly status: number

  constructor(status: number, body: string) {
    super(`Google refused to mint a Document Token, with ${String(status)}: ${body.slice(0, 400)}`)
    this.name = 'DocumentRefused'
    this.status = status
  }
}

export class DepotUnreachable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DepotUnreachable'
  }
}

export interface GoogleDocumentMinterOptions {
  readonly account: string
  readonly privateKey: string
  readonly tokenEndpoint: string
  readonly depot: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

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
      expiresAt:
        typeof lifetimeS === 'number' && Number.isFinite(lifetimeS)
          ? this.#now() + lifetimeS * 1000
          : this.#now(),
    }
  }

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
    if (found.capabilities?.canAddChildren !== true) {
      throw new DepotUnreachable(
        `roma can see the Depot "${this.#depot}" and cannot add anything to it as ${this.account}. ` +
          'On a shared drive that is what a Viewer looks like — the identity needs to be a ' +
          'Contributor, which may create and edit and may not move, trash or delete.',
      )
    }

    return {
      id: typeof found.id === 'string' && found.id !== '' ? found.id : this.#depot,
      name: typeof found.name === 'string' && found.name !== '' ? found.name : this.#depot,
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
