import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FreshTokens } from './fresh-tokens.js'
import { reasonOf, writeToStderr, type OperatorLog } from './operator-log.js'
import type { CredentialWanted, ShimRequest, ShimResponse } from './shim-protocol.js'

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
  readonly log?: OperatorLog<ShimLogRecord>
}

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
  readonly #log: OperatorLog<ShimLogRecord>
  readonly #open = new Set<Socket>()

  private constructor(options: ShimServerOptions, server: Server) {
    this.socketPath = options.socketPath
    this.#server = server
    this.#reaches = options.reaches
    this.#onCredential = options.onCredential ?? (() => {})
    this.#taskFor = options.taskFor
    this.#log = options.log ?? writeToStderr
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
      void this.#answer(line).then((response) => {
        socket.end(`${JSON.stringify(response)}\n`)
      })
    })
    socket.on('error', () => socket.destroy())
  }

  async #answer(line: string): Promise<ShimResponse> {
    let request: ShimRequest
    try {
      request = readRequest(line)
    } catch (error) {
      this.#log({ event: 'shim-unreadable', reason: reasonOf(error) })
      return { token: null, reason: 'roma could not read that request.' }
    }

    const sessionId = request.session
    const taskId = this.#taskFor(sessionId)
    const path = request.path ?? null
    const credential = request.credential ?? 'code'
    const where = { sessionId, taskId, path, credential } as const
    const reach = this.#reaches[credential]

    if (request.operation === 'erase') {
      if ('tokens' in reach && typeof request.token === 'string' && request.token !== '') {
        reach.tokens.discard(request.token)
      }
      this.#log({ event: 'credential-rejected', ...where })
      return { token: null }
    }

    if (!('tokens' in reach)) {
      this.#log({ event: 'credential-failed', ...where, reason: reach.unavailable })
      return { token: null, reason: reach.unavailable }
    }

    try {
      const { token, expiresAt } = await reach.tokens.fresh()
      this.#onCredential(taskId, credential, path)
      this.#log({ event: 'credential', ...where })
      return { token, expiresAt, account: reach.account }
    } catch (error) {
      const reason = reasonOf(error)
      this.#log({ event: 'credential-failed', ...where, reason })
      return { token: null, reason }
    }
  }
}

function readRequest(line: string): ShimRequest {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
  const { session, operation, path, token, credential } = parsed as Record<string, unknown>
  if (typeof session !== 'string' || session === '') throw new Error('no session was named')
  if (operation !== 'get' && operation !== 'erase') {
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
    operation,
    path: typeof path === 'string' ? path : null,
    token: typeof token === 'string' ? token : null,
    credential: credential ?? 'code',
  }
}
