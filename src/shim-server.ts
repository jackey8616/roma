import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FreshTokens } from './fresh-tokens.js'
import {
  checkedGrant,
  entitlementNamed,
  grantNamed,
  type CloudGrantAsked,
  type Grant,
  type GrantAsked,
  type Grants,
} from './grants.js'
import { reasonOf, writeToStderr, type OperatorLog } from './operator-log.js'
import type { CredentialWanted, ShimOperation, ShimRequest, ShimResponse } from './shim-protocol.js'

export type ShimLogRecord =
  | {
      readonly event: 'credential'
      readonly sessionId: string
      readonly taskId: string | null
      readonly path: string | null
      readonly credential: CredentialWanted
    }
  | {
      readonly event: 'credential-rejected'
      readonly sessionId: string
      readonly taskId: string | null
      readonly path: string | null
      readonly credential: CredentialWanted
    }
  | {
      readonly event: 'credential-failed'
      readonly sessionId: string
      readonly taskId: string | null
      readonly path: string | null
      readonly credential: CredentialWanted
      readonly reason: string
    }
  | {
      readonly event: 'shim-unreadable'
      readonly reason: string
    }
  | {
      readonly event: 'cloud-grant'
      readonly sessionId: string
      readonly taskId: string | null
      readonly operation: 'grant' | 'grant-status'
      readonly grant: string
      readonly state: string
    }
  | {
      readonly event: 'cloud-grant-refused'
      readonly sessionId: string
      readonly taskId: string | null
      readonly operation: 'grant' | 'grant-status'
      readonly reason: string
    }
  | {
      readonly event: 'credential-refused'
      readonly claimed: string
      readonly holder: string | null
      readonly path: string | null
      readonly credential: CredentialWanted
    }

export type ServedReach =
  | { readonly tokens: FreshTokens; readonly account: string | null }
  | { readonly unavailable: string }

export type ServedReaches = Readonly<Record<CredentialWanted, ServedReach>>

export interface ShimServerOptions {
  readonly socketPath: string
  readonly reaches: ServedReaches
  readonly onCredential?: (
    taskId: string | null,
    credential: CredentialWanted,
    path: string | null,
  ) => void
  readonly taskFor: (sessionId: string) => string | null
  readonly holder?: () => string | null
  readonly lease?: () => object | null
  readonly log?: OperatorLog<ShimLogRecord>
  readonly grants?: Grants
  readonly onGrant?: (taskId: string, asked: CloudGrantAsked) => void
  readonly beginGrant?: (taskId: string) => () => void
}

const NO_CLOUD_GRANTS: Grants = { unavailable: 'This roma has no Cloud Grants to ask for.' }

export class ShimServer {
  readonly socketPath: string
  readonly #server: Server
  readonly #reaches: ServedReaches
  readonly #onCredential: (
    taskId: string | null,
    credential: CredentialWanted,
    path: string | null,
  ) => void
  readonly #taskFor: (sessionId: string) => string | null
  readonly #holder: (() => string | null) | undefined
  readonly #lease: () => object | null
  readonly #log: OperatorLog<ShimLogRecord>
  readonly #grants: Grants
  readonly #onGrant: (taskId: string, asked: CloudGrantAsked) => void
  readonly #beginGrant: (taskId: string) => () => void
  readonly #open = new Set<Socket>()

  private constructor(options: ShimServerOptions, server: Server) {
    this.socketPath = options.socketPath
    this.#server = server
    this.#reaches = options.reaches
    this.#onCredential = options.onCredential ?? (() => {})
    this.#taskFor = options.taskFor
    this.#holder = options.holder
    this.#lease = options.lease ?? (() => null)
    this.#log = options.log ?? writeToStderr
    this.#grants = options.grants ?? NO_CLOUD_GRANTS
    this.#onGrant = options.onGrant ?? (() => {})
    this.#beginGrant = options.beginGrant ?? (() => () => {})
  }

  static async listen(options: ShimServerOptions): Promise<ShimServer> {
    mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 })
    rmSync(options.socketPath, { force: true })

    const server = createServer()
    const shims = new ShimServer(options, server)
    server.on('connection', (socket) => shims.#serve(socket))

    await new Promise<void>((listening, failed) => {
      server.once('error', failed)
      server.listen(options.socketPath, () => {
        server.off('error', failed)
        listening()
      })
    })
    chmodSync(options.socketPath, 0o600)
    server.unref()
    return shims
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((done) => this.#server.close(() => done()))
    for (const socket of this.#open) socket.destroy()
    this.#open.clear()
    await closed
    rmSync(this.socketPath, { force: true })
  }

  #serve(socket: Socket): void {
    const accepted = { holder: this.#holder?.() ?? null, lease: this.#lease() }
    this.#open.add(socket)
    socket.on('close', () => this.#open.delete(socket))
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end === -1) return
      const line = buffer.slice(0, end)
      buffer = ''
      socket.removeAllListeners('data')
      void this.#answer(line, accepted).then((response) => {
        socket.end(`${JSON.stringify(response)}\n`)
      })
    })
    socket.on('error', () => socket.destroy())
  }

  async #answer(
    line: string,
    accepted: { readonly holder: string | null; readonly lease: object | null },
  ): Promise<ShimResponse> {
    let request: ShimRequest
    try {
      request = readRequest(line)
    } catch (error) {
      this.#log({ event: 'shim-unreadable', reason: reasonOf(error) })
      return { token: null, reason: 'roma could not read that request.' }
    }

    const sessionId = request.session
    const path = request.path ?? null
    const credential = request.credential ?? 'code'
    const refuse = (holder: string | null): ShimResponse => {
      this.#log({ event: 'credential-refused', claimed: sessionId, holder, path, credential })
      return { token: null, reason: 'this socket does not belong to that Session.' }
    }
    const heldNow = (): boolean =>
      this.#holder === undefined ||
      (this.#holder() === sessionId &&
        accepted.holder === sessionId &&
        this.#lease() === accepted.lease)
    if (!heldNow()) return refuse(this.#holder?.() ?? null)
    if (request.operation === 'grant' || request.operation === 'grant-status') {
      return await this.#grant(request, sessionId, heldNow, refuse)
    }
    const where = () => ({ sessionId, taskId: this.#taskFor(sessionId), path, credential }) as const
    const reach = this.#reaches[credential]

    if (request.operation === 'erase') {
      if ('tokens' in reach && typeof request.token === 'string' && request.token !== '') {
        reach.tokens.discard(request.token)
      }
      this.#log({ event: 'credential-rejected', ...where() })
      return { token: null }
    }

    if (!('tokens' in reach)) {
      this.#log({ event: 'credential-failed', ...where(), reason: reach.unavailable })
      return { token: null, reason: reach.unavailable }
    }

    try {
      const { token, expiresAt } = await reach.tokens.fresh()
      if (!heldNow()) return refuse(this.#holder?.() ?? null)
      const served = where()
      this.#onCredential(served.taskId, credential, path)
      this.#log({ event: 'credential', ...served })
      return { token, expiresAt, account: reach.account }
    } catch (error) {
      if (!heldNow()) return refuse(this.#holder?.() ?? null)
      const reason = reasonOf(error)
      this.#log({ event: 'credential-failed', ...where(), reason })
      return { token: null, reason }
    }
  }

  async #grant(
    request: ShimRequest,
    sessionId: string,
    heldNow: () => boolean,
    refuse: (holder: string | null) => ShimResponse,
  ): Promise<ShimResponse> {
    const operation = request.operation as 'grant' | 'grant-status'
    const taskId = this.#taskFor(sessionId)
    const refused = (reason: string): ShimResponse => {
      this.#log({ event: 'cloud-grant-refused', sessionId, taskId, operation, reason })
      return { token: null, reason }
    }
    const grants = this.#grants
    if (!('requests' in grants)) return refused(grants.unavailable)
    const entitlements = grants.requests.entitlements()

    let asked: () => Promise<Grant>
    let told: ((grant: Grant) => CloudGrantAsked) | null = null
    if (operation === 'grant') {
      if (request.grant === undefined || request.grant === null) {
        return refused('a Cloud Grant request named no entitlement.')
      }
      const checked = checkedGrant(request.grant, taskId, entitlements)
      if ('refused' in checked) return refused(checked.refused)
      const found = entitlementNamed(checked.ok.entitlement, entitlements)
      if ('refused' in found) return refused(found.refused)
      asked = () => grants.requests.request(checked.ok)
      told = (grant) => ({
        grant,
        entitlement: found.ok,
        durationS: checked.ok.durationS,
        justification: checked.ok.justification,
      })
    } else {
      const named = grantNamed(request.grantName ?? '', entitlements)
      if ('refused' in named) return refused(named.refused)
      asked = () => grants.requests.status(named.ok)
    }

    const done = told !== null && taskId !== null ? this.#beginGrant(taskId) : () => {}
    try {
      const grant = await asked()
      if (told !== null && taskId !== null) this.#onGrant(taskId, told(grant))
      this.#log({
        event: 'cloud-grant',
        sessionId,
        taskId,
        operation,
        grant: grant.name,
        state: grant.state,
      })
      if (!heldNow()) return refuse(this.#holder?.() ?? null)
      return { token: null, grant }
    } catch (error) {
      if (!heldNow()) return refuse(this.#holder?.() ?? null)
      return refused(reasonOf(error))
    } finally {
      done()
    }
  }
}

const OPERATIONS: readonly ShimOperation[] = ['get', 'erase', 'grant', 'grant-status']

function readGrant(value: unknown): GrantAsked | null {
  if (typeof value !== 'object' || value === null) return null
  const { entitlement, durationS, justification } = value as Record<string, unknown>
  if (
    typeof entitlement !== 'string' ||
    typeof durationS !== 'number' ||
    typeof justification !== 'string'
  ) {
    throw new Error('a Cloud Grant request needs an entitlement, a duration and a justification')
  }
  return { entitlement, durationS, justification }
}

function readRequest(line: string): ShimRequest {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
  const { session, operation, path, token, credential, grant, grantName } = parsed as Record<
    string,
    unknown
  >
  if (typeof session !== 'string' || session === '') throw new Error('no session was named')
  if (!OPERATIONS.includes(operation as ShimOperation)) {
    throw new Error(`unknown operation ${JSON.stringify(operation)}`)
  }
  if (
    credential !== undefined &&
    credential !== 'code' &&
    credential !== 'cloud' &&
    credential !== 'documents'
  ) {
    throw new Error(`unknown credential ${JSON.stringify(credential)}`)
  }
  return {
    session,
    operation: operation as ShimOperation,
    path: typeof path === 'string' ? path : null,
    token: typeof token === 'string' ? token : null,
    credential: credential ?? 'code',
    grant: operation === 'grant' ? readGrant(grant) : null,
    grantName: typeof grantName === 'string' ? grantName : null,
  }
}
