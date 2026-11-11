import { FreshTokens } from '../fresh-tokens.js'
import type { Entitlement, Grant, GrantAsked, RequestsGrants } from '../grants.js'
import type { MintsTokens } from '../reach.js'

export const PAM_API = 'https://privilegedaccessmanager.googleapis.com/v1'

const CONSOLE_APPROVALS = 'https://console.cloud.google.com/iam-admin/pam/grants/approvals'

const SCOPE_SHAPE = /^(projects|folders|organizations)\/[^/\s]+$/

export class GrantRefused extends Error {
  readonly status: number

  constructor(what: string, status: number, body: string) {
    super(`Google refused to ${what}, with ${String(status)}: ${body.slice(0, 400)}`)
    this.name = 'GrantRefused'
    this.status = status
  }
}

export function isGrantScope(scope: string): boolean {
  return SCOPE_SHAPE.test(scope)
}

export function approvalsFor(name: string): string | null {
  const [kind, id] = name.split('/')
  if (id === undefined || id === '') return null
  const query =
    kind === 'projects'
      ? `project=${encodeURIComponent(id)}`
      : kind === 'folders'
        ? `folder=${encodeURIComponent(id)}`
        : kind === 'organizations'
          ? `organizationId=${encodeURIComponent(id)}`
          : null
  return query === null ? null : `${CONSOLE_APPROVALS}?${query}`
}

export function secondsOf(duration: unknown): number | null {
  if (typeof duration !== 'string') return null
  const match = /^(\d+)(?:\.\d+)?s$/.exec(duration)
  return match === null ? null : Number(match[1])
}

interface RawEntitlement {
  readonly name?: unknown
  readonly maxRequestDuration?: unknown
  readonly privilegedAccess?: {
    readonly gcpIamAccess?: { readonly roleBindings?: readonly RawBinding[] }
  }
}

interface RawBinding {
  readonly role?: unknown
  readonly conditionExpression?: unknown
}

export function entitlementFrom(raw: RawEntitlement): Entitlement | null {
  const maxDurationS = secondsOf(raw.maxRequestDuration)
  if (typeof raw.name !== 'string' || raw.name === '' || maxDurationS === null) return null
  const bindings = raw.privilegedAccess?.gcpIamAccess?.roleBindings ?? []
  return {
    name: raw.name,
    roles: bindings.flatMap(({ role }) => (typeof role === 'string' ? [role] : [])),
    conditions: bindings.flatMap(({ conditionExpression }) =>
      typeof conditionExpression === 'string' && conditionExpression !== ''
        ? [conditionExpression]
        : [],
    ),
    maxDurationS,
  }
}

function grantFrom(raw: unknown): Grant {
  const { name, state } = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  if (typeof name !== 'string' || name === '') {
    throw new Error('Google answered about a grant without naming it.')
  }
  const at = name.indexOf('/grants/')
  return {
    name,
    state: typeof state === 'string' && state !== '' ? state : 'STATE_UNSPECIFIED',
    entitlement: at === -1 ? name : name.slice(0, at),
    approveAt: approvalsFor(name),
  }
}

export interface PamGrantsOptions {
  readonly minter: MintsTokens
  readonly scopes: readonly string[]
  readonly fetch?: typeof globalThis.fetch
}

export class PamGrants implements RequestsGrants {
  readonly scopes: readonly string[]
  readonly #tokens: FreshTokens
  readonly #fetch: typeof globalThis.fetch
  #found: readonly Entitlement[] | null = null

  constructor({ minter, scopes, fetch = globalThis.fetch }: PamGrantsOptions) {
    this.scopes = scopes
    this.#tokens = new FreshTokens({ minter })
    this.#fetch = fetch
  }

  entitlements(): readonly Entitlement[] {
    if (this.#found === null) throw new Error('roma listed its entitlements before finding them')
    return this.#found
  }

  async find(): Promise<readonly Entitlement[]> {
    const found: Entitlement[] = []
    for (const scope of this.scopes) {
      const inScope = await this.#search(scope)
      if (inScope.length === 0) {
        throw new Error(
          `roma's Cloud Reach is eligible for no entitlement in ${scope}. Either the scope is ` +
            'wrong, or no entitlement names the Cloud Reach as somebody who may request it.',
        )
      }
      found.push(...inScope)
    }
    this.#found = found
    return found
  }

  async request(asked: GrantAsked): Promise<Grant> {
    const response = await this.#call(`${PAM_API}/${asked.entitlement}/grants`, {
      method: 'POST',
      body: JSON.stringify({
        requestedDuration: `${String(asked.durationS)}s`,
        justification: { unstructuredJustification: asked.justification },
      }),
    })
    if (!response.ok) {
      throw new GrantRefused(
        `request a grant on ${asked.entitlement}`,
        response.status,
        await response.text(),
      )
    }
    return grantFrom(await response.json())
  }

  async status(name: string): Promise<Grant> {
    const response = await this.#call(`${PAM_API}/${name}`, { method: 'GET' })
    if (!response.ok) {
      throw new GrantRefused(`say how ${name} stands`, response.status, await response.text())
    }
    return grantFrom(await response.json())
  }

  async #search(scope: string): Promise<Entitlement[]> {
    const found: Entitlement[] = []
    let page: string | null = null
    do {
      const query = new URLSearchParams({ callerAccessType: 'GRANT_REQUESTER', pageSize: '100' })
      if (page !== null) query.set('pageToken', page)
      const response = await this.#call(
        `${PAM_API}/${scope}/locations/global/entitlements:search?${query.toString()}`,
        { method: 'GET' },
      )
      if (!response.ok) {
        throw new GrantRefused(
          `list what roma's Cloud Reach may request in ${scope}`,
          response.status,
          await response.text(),
        )
      }
      const body = (await response.json()) as { entitlements?: unknown; nextPageToken?: unknown }
      const listed = Array.isArray(body.entitlements) ? (body.entitlements as RawEntitlement[]) : []
      for (const raw of listed) {
        const entitlement = entitlementFrom(raw)
        if (entitlement !== null) found.push(entitlement)
      }
      page =
        typeof body.nextPageToken === 'string' && body.nextPageToken !== ''
          ? body.nextPageToken
          : null
    } while (page !== null)
    return found
  }

  async #call(url: string, init: { method: string; body?: string }): Promise<Response> {
    const token = await this.#tokens.current()
    return await this.#fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    })
  }
}
