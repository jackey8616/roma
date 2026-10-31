import { connect } from 'node:net'
import { reasonOf } from './operator-log.js'
import {
  MINTER_SOCKET_VAR,
  SESSION_ID_VAR,
  type ShimRequest,
  type ShimResponse,
} from './shim-protocol.js'

/**
 * The agent's side of the Credential Shim contract, shared by both Shims: open
 * the socket roma named, send one line, read one line. One copy, because two
 * would drift at the first change to the protocol.
 */

export interface ShimEnvironment {
  readonly socketPath: string
  readonly sessionId: string
}

/**
 * Where roma is, and which Session this is, out of the process environment.
 *
 * Throws rather than defaulting, naming the variable that is missing. Enforced
 * by `fence:shim-a-missing-variable-is-said`.
 */
export function shimEnvironment(env: NodeJS.ProcessEnv = process.env): ShimEnvironment {
  const socketPath = env[MINTER_SOCKET_VAR]
  const sessionId = env[SESSION_ID_VAR]
  if (socketPath === undefined || socketPath === '') {
    throw new Error(`${MINTER_SOCKET_VAR} is not set, so there is no roma to ask for a credential.`)
  }
  if (sessionId === undefined || sessionId === '') {
    throw new Error(`${SESSION_ID_VAR} is not set, so roma cannot be told which Session is asking.`)
  }
  return { socketPath, sessionId }
}

/**
 * Ask roma one question and wait for its answer.
 *
 * Rejects only where the socket itself could not be used: a roma that answered
 * "no credential, and here is why" resolves. Enforced by
 * `fence:shim-no-credential-is-an-answer`.
 */
export async function askMinter(socketPath: string, request: ShimRequest): Promise<ShimResponse> {
  return await new Promise<ShimResponse>((answered, failed) => {
    const socket = connect(socketPath)
    socket.setEncoding('utf8')
    let buffer = ''

    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
    })
    socket.on('error', failed)
    socket.on('close', () => {
      try {
        answered(readResponse(buffer))
      } catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

/**
 * A credential, or the sentence to put in front of the person about why there
 * is not one. The token goes somewhere tool-specific; the sentence always goes to
 * stderr, beside the tool's own failure.
 */
export interface ShimAnswer {
  readonly token: string | null
  /** What to write on stderr. Null where nothing went wrong. */
  readonly complaint: string | null
}

/**
 * Ask roma for a credential, and turn every way that can fail into one sentence.
 *
 * Never rejects. Enforced by `fence:shim-credential-for-never-rejects`.
 *
 * Enforced by `fence:shim-complaint-names-no-forge`.
 */
export async function credentialFor(
  request: Omit<ShimRequest, 'session'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShimAnswer> {
  let shim: ShimEnvironment
  try {
    shim = shimEnvironment(env)
  } catch (error) {
    return { token: null, complaint: reasonOf(error) }
  }

  let answer: ShimResponse
  try {
    answer = await askMinter(shim.socketPath, { ...request, session: shim.sessionId })
  } catch (error) {
    return {
      token: null,
      complaint: `roma could not be reached for a credential: ${reasonOf(error)}`,
    }
  }

  if (answer.token !== null) return { token: answer.token, complaint: null }
  // An `erase` is roma being told something, not asked for something. Answering
  // it with no credential is the whole of a successful exchange, and complaining
  // would put a line on stderr for every authentication failure git already
  // reports perfectly well itself.
  if (request.operation === 'erase') return { token: null, complaint: null }
  return {
    token: null,
    complaint: `roma has no credential to give: ${answer.reason ?? 'no reason given'}`,
  }
}

function readResponse(body: string): ShimResponse {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('roma answered with nonsense')
  const { token, reason, expiresAt, account } = parsed as Record<string, unknown>
  return {
    token: typeof token === 'string' ? token : null,
    ...(typeof reason === 'string' ? { reason } : {}),
    // Carried through rather than required: an answer with no token carries
    // neither, and an older roma answered some requests without them.
    ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
    // A null account is passed through rather than dropped. Dropping it would
    // make "roma answered no account" indistinguishable from "roma did not answer
    // one", which is the difference `--json` exists to report honestly.
    ...(typeof account === 'string' || account === null ? { account } : {}),
  }
}
