import { connect } from 'node:net'
import { reasonOf } from './operator-log.js'
import {
  MINTER_SOCKET_VAR,
  SESSION_ID_VAR,
  type ShimRequest,
  type ShimResponse,
} from './shim-protocol.js'

export interface ShimEnvironment {
  readonly socketPath: string
  readonly sessionId: string
}

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

export interface ShimAnswer {
  readonly token: string | null
  readonly complaint: string | null
}

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
    ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
    ...(typeof account === 'string' || account === null ? { account } : {}),
  }
}
