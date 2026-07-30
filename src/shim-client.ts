import { connect } from 'node:net'
import {
  MINTER_SOCKET_VAR,
  SESSION_ID_VAR,
  type ShimRequest,
  type ShimResponse,
} from './shim-protocol.js'

/**
 * The agent's side of the Credential Shim contract, shared by both Shims.
 *
 * Here rather than beside either of them because the two Shims agree about
 * nothing else: one speaks `git`'s credential dialect and the other rewrites an
 * environment for one child process. What they have in common is exactly this —
 * open the socket roma named, send one line, read one line — and two copies of
 * it would drift at the first change to the protocol.
 *
 * Nothing here is a secret and nothing here decides anything. That is the whole
 * point of a Shim.
 */

/** What the Shim's own environment tells it. */
export interface ShimEnvironment {
  readonly socketPath: string
  readonly sessionId: string
}

/**
 * Where roma is, and which Session this is, out of the process environment.
 *
 * Throws rather than defaulting. A Shim that quietly carried on with no socket
 * to ask would answer every request with no credential, which presents as
 * authentication failing — a diagnosis that sends somebody to look at the App
 * rather than at the two variables that are missing.
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
 * Rejects only where the socket itself could not be used. A roma that answered
 * "no credential, and here is why" is a successful exchange — the reason is what
 * the Shim has to pass on, and losing it to an exception would leave the tool
 * saying "authentication failed" with nothing behind it.
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

function readResponse(body: string): ShimResponse {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('roma answered with nonsense')
  const { token, reason } = parsed as Record<string, unknown>
  return {
    token: typeof token === 'string' ? token : null,
    ...(typeof reason === 'string' ? { reason } : {}),
  }
}
