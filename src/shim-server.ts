import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { InstallationTokens } from './installation-tokens.js'
import { reasonOf, writeToStderr, type OperatorLog } from './operator-log.js'
import type { ShimRequest, ShimResponse } from './shim-protocol.js'

/**
 * One credential request, as an operator sees it.
 *
 * Attribution is by Session, resolved to a Task through the Task Queue, and a
 * request that belongs to no running Task is written down as belonging to no
 * Task. Not attributed to the nearest one — the same rule the Audit Record
 * already applies when it records a Turn as unpriced rather than as free.
 */
export type ShimLogRecord =
  | {
      /** A tool asked, and was given a credential. */
      readonly event: 'credential'
      readonly sessionId: string
      readonly taskId: string | null
      readonly path: string | null
    }
  | {
      /**
       * A tool handed a credential back as rejected, and roma dropped it.
       *
       * Worth its own line because it is the one thing that says a token roma
       * believes in has stopped working — a rotated key, a revoked App — and
       * without it the next hour is identical failures with no cause attached.
       */
      readonly event: 'credential-rejected'
      readonly sessionId: string
      readonly taskId: string | null
      readonly path: string | null
    }
  | {
      /**
       * roma could not produce a credential.
       *
       * Nothing else happens: the Shim answers with none, the tool fails in its
       * own words, and the agent reports that to the person in the context of
       * what it was attempting. This line is the whole of the operator's side of
       * it, and it is what makes three people's Tasks failing separately
       * recognisable as one cause.
       */
      readonly event: 'credential-failed'
      readonly sessionId: string
      readonly taskId: string | null
      readonly path: string | null
      readonly reason: string
    }
  | {
      /** Something spoke to the socket that is not a Shim. */
      readonly event: 'shim-unreadable'
      readonly reason: string
    }

export interface ShimServerOptions {
  /**
   * Where the socket goes.
   *
   * A Unix domain socket rather than a TCP port: filesystem permissions are the
   * access control, there is no port to allocate or collide, and nothing outside
   * the container can reach it — which matters, because behind it is a credential
   * that can write to the whole Installation.
   */
  readonly socketPath: string
  readonly tokens: InstallationTokens
  /**
   * Which Task that Session is running right now, or null.
   *
   * The Task Queue's answer. It serialises the Tasks of a Session already, so
   * there is never more than one and the answer is unambiguous — and a request
   * arriving when the Session has no running Task is a background process, or
   * work that outlived its Task, and is recorded as belonging to no Task.
   */
  readonly taskFor: (sessionId: string) => string | null
  readonly log?: OperatorLog<ShimLogRecord>
}

/**
 * roma's side of the Credential Shim contract.
 *
 * A Shim holds nothing and decides nothing; this is where the decisions are. It
 * is also **not a boundary against the agent** — the agent has a shell under
 * `bypassPermissions` and can connect to this socket itself, or simply run
 * `git credential fill`. What the arrangement buys is that no credential is ever
 * fixed into a process environment or a file, so nothing longer-lived than the
 * operation that needed it can reach a Transcript roma has promised never to
 * delete (ADR-0006).
 *
 * One request per connection. Simpler than framing a stream both ways, and it
 * costs nothing worth measuring next to the process the Shim already is.
 */
export class ShimServer {
  readonly socketPath: string
  readonly #server: Server
  readonly #tokens: InstallationTokens
  readonly #taskFor: (sessionId: string) => string | null
  readonly #log: OperatorLog<ShimLogRecord>

  private constructor(options: ShimServerOptions, server: Server) {
    this.socketPath = options.socketPath
    this.#server = server
    this.#tokens = options.tokens
    this.#taskFor = options.taskFor
    this.#log = options.log ?? writeToStderr
  }

  /**
   * Make the directory, take the socket, and start answering.
   *
   * The stale socket is removed first. A container that was killed rather than
   * stopped leaves the file behind, and `listen` on an existing path fails with
   * EADDRINUSE — which would present as roma refusing to boot after every hard
   * restart, for a file that nothing is listening on.
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

  /** Stop answering, and take the socket file with it. */
  async close(): Promise<void> {
    await new Promise<void>((closed) => this.#server.close(() => closed()))
    rmSync(this.socketPath, { force: true })
  }

  /** One connection: one line in, one line out, then closed. */
  #serve(socket: Socket): void {
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

  /** What one request is answered with, and what it is written down as. */
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

    if (request.operation === 'erase') {
      if (typeof request.token === 'string' && request.token !== '') {
        this.#tokens.discard(request.token)
      }
      this.#log({ event: 'credential-rejected', sessionId, taskId, path })
      return { token: null }
    }

    try {
      const token = await this.#tokens.current()
      this.#log({ event: 'credential', sessionId, taskId, path })
      return { token }
    } catch (error) {
      const reason = reasonOf(error)
      this.#log({ event: 'credential-failed', sessionId, taskId, path, reason })
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
  const { session, operation, path, token } = parsed as Record<string, unknown>
  if (typeof session !== 'string' || session === '') throw new Error('no session was named')
  if (operation !== 'get' && operation !== 'erase') {
    throw new Error(`unknown operation ${JSON.stringify(operation)}`)
  }
  return {
    session,
    operation,
    path: typeof path === 'string' ? path : null,
    token: typeof token === 'string' ? token : null,
  }
}
