import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FreshTokens } from './fresh-tokens.js'
import { reasonOf, writeToStderr, type OperatorLog } from './operator-log.js'
import type { CredentialWanted, ShimRequest, ShimResponse } from './shim-protocol.js'

/**
 * One credential request, as an operator sees it. Every request is written
 * down, not only the failures, so that one belonging to no running Task is
 * recorded as such.
 *
 * Attribution is by Session, resolved to a Task through the Task Queue; a
 * request belonging to no running Task has a null `taskId`, never the nearest
 * Task's.
 */
export type ShimLogRecord =
  | {
      /** A tool asked, and was given a credential. */
      readonly event: 'credential'
      readonly sessionId: string
      readonly taskId: string | null
      readonly path: string | null
      readonly credential: CredentialWanted
    }
  | {
      /**
       * A tool handed a credential back as rejected, and roma dropped it: the
       * one sign a token roma believes in has stopped working.
       */
      readonly event: 'credential-rejected'
      readonly sessionId: string
      readonly taskId: string | null
      readonly path: string | null
      readonly credential: CredentialWanted
    }
  | {
      /**
       * roma could not produce a credential. The Shim answers with none and the
       * tool fails in its own words; this line is the operator's whole view.
       */
      readonly event: 'credential-failed'
      readonly sessionId: string
      readonly taskId: string | null
      readonly path: string | null
      readonly credential: CredentialWanted
      readonly reason: string
    }
  | {
      /** Something spoke to the socket that is not a Shim. */
      readonly event: 'shim-unreadable'
      readonly reason: string
    }

/**
 * One Reach, as the socket sees it: something to mint from and the account it
 * proved at boot, or the sentence roma answers with where there is nothing.
 */
export type ServedReach =
  | { readonly tokens: FreshTokens; readonly account: string | null }
  | { readonly unavailable: string }

/** One of those per credential something can ask for: total over `CredentialWanted`. */
export type ServedReaches = Readonly<Record<CredentialWanted, ServedReach>>

export interface ShimServerOptions {
  /**
   * Where the Unix domain socket goes. Its directory is made `0700` and the
   * socket `0600`; a stale one is replaced.
   *
   * A socket rather than a TCP port: filesystem permissions are the access
   * control, there is no port to collide, and nothing outside the container can
   * reach a credential that can write to the whole Installation.
   */
  readonly socketPath: string
  /** What to answer each credential with. A Reach with no key is present, unavailable. */
  readonly reaches: ServedReaches
  /**
   * Told of every credential served, of every kind, before it is logged or
   * handed over. `taskId` is null for a request belonging to no running Task.
   */
  readonly onCredential?: (
    taskId: string | null,
    credential: CredentialWanted,
    path: string | null,
  ) => void
  /**
   * Which Task that Session is running right now, or null: the Task Queue's
   * `taskFor`. A request while none runs is recorded as belonging to no Task.
   */
  readonly taskFor: (sessionId: string) => string | null
  readonly log?: OperatorLog<ShimLogRecord>
}

/**
 * roma's side of the Credential Shim contract: where the decisions are. Not a
 * boundary against the agent, which can connect to this socket itself.
 *
 * One request per connection: one JSON line in, one JSON line back. Simpler
 * than framing a stream both ways, at no cost worth measuring.
 */
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
  /** Enforced by `fence:shim-close-cuts-open-connections`. */
  readonly #open = new Set<Socket>()

  private constructor(options: ShimServerOptions, server: Server) {
    this.socketPath = options.socketPath
    this.#server = server
    this.#reaches = options.reaches
    this.#onCredential = options.onCredential ?? (() => {})
    this.#taskFor = options.taskFor
    this.#log = options.log ?? writeToStderr
  }

  /**
   * Make the directory, take the socket, and start answering.
   *
   * A stale socket left by a boot that did not clean up is removed first.
   * Enforced by `fence:shim-stale-socket-taken-over`.
   */
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
    // Set after the socket exists, since `listen` is what creates it. Belt and
    // braces over the directory's own mode: both roma and the agent run as the
    // same user inside the container, so this stops nothing the agent could do
    // — what it stops is anything else that shares the host.
    chmodSync(options.socketPath, 0o600)
    server.unref()
    return shims
  }

  /**
   * Stop answering, and take the socket file with it.
   *
   * Open connections are cut rather than waited for. Enforced by
   * `fence:shim-close-cuts-open-connections`.
   */
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
    // A Shim that died mid-request is not roma's problem, and an unhandled
    // socket error would be the process's.
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
    // Enforced by `fence:shim-each-credential-from-its-own-reach`. Enforced by `fence:shim-credential-wanted-is-closed`.
    const reach = this.#reaches[credential]

    if (request.operation === 'erase') {
      // Enforced by `fence:shim-erase-routed-by-reach`.
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
      // Before the log line and before the answer, so that a Task credited with a
      // credential is one that was actually handed one.
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

/**
 * One request, checked rather than cast.
 *
 * Everything that reaches this socket was written by something in the agent's
 * userland, which is a place the agent can put programs of its own. A cast would
 * turn a malformed line into a `TypeError` inside roma; a check turns it into an
 * answer with no credential in it.
 */
function readRequest(line: string): ShimRequest {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
  const { session, operation, path, token, credential } = parsed as Record<string, unknown>
  if (typeof session !== 'string' || session === '') throw new Error('no session was named')
  if (operation !== 'get' && operation !== 'erase') {
    throw new Error(`unknown operation ${JSON.stringify(operation)}`)
  }
  // Enforced by `fence:shim-unknown-credential-refused`.
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
