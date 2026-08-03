import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FreshTokens } from './fresh-tokens.js'
import { reasonOf, writeToStderr, type OperatorLog } from './operator-log.js'
import type { CredentialWanted, ShimRequest, ShimResponse } from './shim-protocol.js'

/**
 * One credential request, as an operator sees it.
 *
 * Attribution is by Session, resolved to a Task through the Task Queue, and a
 * request that belongs to no running Task is written down as belonging to no
 * Task. Not attributed to the nearest one — the same rule the Audit Record
 * already applies when it records a Turn as unpriced rather than as free.
 *
 * Every request is written down, not only the failures. That is more than a
 * failure log and less than an Audit Record, and it is deliberately both: what
 * is asked for is that a request "belongs to no running Task" be *recorded* as
 * such, which needs the ordinary case written down to be a record of anything.
 * The Audit Record gaining the repositories a Task minted for is a separate
 * ticket and nothing here writes one — this is the Operator Log, which is not
 * totalled and is where roma's running commentary goes.
 */
export type ShimLogRecord =
  | {
      /**
       * A tool asked, and was given a credential.
       *
       * `credential` says which of the three, because they are different events
       * to an operator: one is somebody's `git` doing its job, one is a Cloud
       * Token minted against an identity whose Google Cloud bill somebody pays,
       * and one is a Document Token about to write into a folder a team shares. A
       * mint storm on any of them is visible here, and telling them apart is the
       * first thing anybody looking would want.
       */
      readonly event: 'credential'
      readonly sessionId: string
      readonly taskId: string | null
      readonly path: string | null
      readonly credential: CredentialWanted
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
      readonly credential: CredentialWanted
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
      readonly credential: CredentialWanted
      readonly reason: string
    }
  | {
      /** Something spoke to the socket that is not a Shim. */
      readonly event: 'shim-unreadable'
      readonly reason: string
    }

/**
 * One Reach, as the socket sees it: something to mint from, or a reason there is
 * nothing.
 *
 * The account rides along with the tokens rather than being asked for per
 * request, for the reason a Reach is a value roma holds: it is fixed at boot and
 * identical in every Session.
 *
 * A union rather than nullable fields, so that reading `tokens` off a Reach with
 * none does not typecheck. What the unavailable arm carries is the sentence roma
 * answers with, which is the Reach's own — the Core is not the place a sentence
 * about somebody's cloud belongs (ADR-0020 §2).
 */
export type ServedReach =
  | { readonly tokens: FreshTokens; readonly account: string | null }
  | { readonly unavailable: string }

/**
 * One of those per credential something can ask for.
 *
 * Total over `CredentialWanted`, which is what makes `readRequest`'s check the
 * whole of the validation: a request naming a credential this record does not
 * have is not representable, so there is no missing-entry case to design an
 * answer for.
 */
export type ServedReaches = Readonly<Record<CredentialWanted, ServedReach>>

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
  /**
   * What to answer each credential with.
   *
   * One entry per credential and no absences: a Reach a deployment has no key for
   * is present and carries the sentence it answers with, because "there is none"
   * is an answer roma gives out loud rather than a case it has no branch for
   * (ADR-0015 §9, ADR-0020 §2).
   */
  readonly reaches: ServedReaches
  /**
   * Told that a credential was served, so that something else can decide what is
   * worth remembering about it.
   *
   * A callback rather than a record kept here, because what this owns is one
   * request over one socket and what an Audit Record is filed against is a Task
   * that has ended. Called with null for a request belonging to no running Task,
   * which is the same honesty the log above keeps: a background process the agent
   * left running is attributed to nobody rather than to the nearest Task.
   *
   * Every credential rather than one of them. Which of them is interesting is not
   * the socket's question — what a Task reached for is a property of the requests
   * that crossed it, and the shapes worth keeping differ per credential: whether
   * the Cloud Reach or the Document Reach was used is a yes or a no and never a
   * count (ADR-0015 §10, ADR-0022 §9), and which repositories a Task minted for
   * is a list accumulated from `path`. One observer serves all three
   * (ADR-0020 §6).
   */
  readonly onCredential?: (
    taskId: string | null,
    credential: CredentialWanted,
    path: string | null,
  ) => void
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
  readonly #reaches: ServedReaches
  readonly #onCredential: (
    taskId: string | null,
    credential: CredentialWanted,
    path: string | null,
  ) => void
  readonly #taskFor: (sessionId: string) => string | null
  readonly #log: OperatorLog<ShimLogRecord>
  /**
   * The connections currently open, so that `close` can cut them.
   *
   * `net.Server.close` waits for every one of them, and unlike `http.Server`
   * there is no `closeAllConnections` to ask for. Kept rather than hoped about,
   * because a Shim that connects and never speaks would otherwise be the reason
   * roma does not shut down.
   */
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

  /**
   * Stop answering, and take the socket file with it.
   *
   * Open connections are cut rather than waited for. This runs after every
   * Session's process is already dead, so anything still holding a connection is
   * a Shim whose tool has nothing left to talk to — and `close` alone waits for
   * every one of them, which would make a Shim that never disconnects the reason
   * roma does not shut down.
   */
  async close(): Promise<void> {
    const closed = new Promise<void>((done) => this.#server.close(() => done()))
    for (const socket of this.#open) socket.destroy()
    this.#open.clear()
    await closed
    rmSync(this.socketPath, { force: true })
  }

  /** One connection: one line in, one line out, then closed. */
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
    const credential = request.credential ?? 'code'
    const where = { sessionId, taskId, path, credential } as const
    // Looked up once. Which credential a request is about is the only question
    // that branches here, and asking it in each of the three places below would
    // be three chances to answer it differently — the worst of which hands a
    // Cloud Shortcut an Installation Token, and looks like everything working
    // until the first API call.
    //
    // Total, so there is no missing entry to answer for: a Reach a deployment has
    // no key for is present and carries its own refusal.
    const reach = this.#reaches[credential]

    if (request.operation === 'erase') {
      // Only `git` ever sends one — the Cloud Shortcut has nothing to hand back,
      // because nothing it prints goes through a tool that could report the
      // rejection. It is routed by the Reach all the same, so that a caller who
      // does send one cannot drop the *other* credential by naming the wrong
      // side: an agent could otherwise force a re-mint of every Session's
      // Installation Token by erasing tokens labelled cloud.
      //
      // Ahead of the unavailable answer below, and deliberately: an erase for a
      // credential roma has none of is a rejection of nothing, and it has always
      // been recorded as `credential-rejected` rather than as a failure.
      if ('tokens' in reach && typeof request.token === 'string' && request.token !== '') {
        reach.tokens.discard(request.token)
      }
      this.#log({ event: 'credential-rejected', ...where })
      return { token: null }
    }

    // Said rather than failed. A deployment with no Cloud Reach is the ordinary
    // case, and the Cloud Shortcut is installed on every image so that this
    // sentence is what an agent reads — a refusal it can repeat to a person,
    // rather than a hang, a crash, or a `PATH` it would go and investigate. The
    // sentence is the Reach's; roma reads it rather than holding it.
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
      // Everything roma knows about the answer, to every asker. Withholding the
      // expiry and the account from the two Credential Shims was minimalism
      // rather than protection — neither has a field to put them in and both
      // collapse the response to a token before anything reads it — and the
      // branch that did it was where a Reach could be paired with the wrong
      // tokens (ADR-0020 §9).
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
  // Absent is `code`, which is what the two Credential Shims send and what every
  // request sent before there was a second credential meant. A value that is not
  // one of the three is refused rather than defaulted: defaulting it would answer
  // a request for a credential roma does not have with one it does.
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
