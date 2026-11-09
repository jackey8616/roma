import { reasonOf } from './operator-log.js'
import { askMinter, shimEnvironment } from './shim-client.js'
import type { CredentialWanted, ShimResponse } from './shim-protocol.js'

const FAILED = 1
const MISUSED = 2

export interface ShortcutOptions {
  readonly name: string
  readonly credential: CredentialWanted
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly out: NodeJS.WritableStream
  readonly err: NodeJS.WritableStream
}

export async function shortcut({
  name,
  credential,
  argv,
  env,
  out,
  err,
}: ShortcutOptions): Promise<number> {
  const unknown = argv.filter((argument) => argument !== '--json')
  if (unknown.length > 0) {
    err.write(
      `${name}: ${JSON.stringify(unknown[0])} is not something it takes. ` +
        `Run it with no arguments for the token, or with --json for the token, its expiry and the account.\n`,
    )
    return MISUSED
  }

  let answer: ShimResponse
  try {
    const shim = shimEnvironment(env)
    answer = await askMinter(shim.socketPath, {
      session: shim.sessionId,
      operation: 'get',
      credential,
      path: null,
    })
  } catch (error) {
    err.write(`${name}: roma could not be reached for a credential: ${reasonOf(error)}\n`)
    return FAILED
  }

  const { token, expiresAt, account } = answer
  if (token === null) {
    err.write(`${name}: ${answer.reason ?? 'roma gave no reason.'}\n`)
    return FAILED
  }

  out.write(
    argv.includes('--json')
      ? `${JSON.stringify({
          token,
          expiresAt: expiresAt === undefined ? null : new Date(expiresAt).toISOString(),
          account: account ?? null,
        })}\n`
      : `${token}\n`,
  )
  return 0
}
