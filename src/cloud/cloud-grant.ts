import { fileURLToPath } from 'node:url'
import { reasonOf } from '../operator-log.js'
import { askMinter, shimEnvironment } from '../shim-client.js'
import type { ShimRequest, ShimResponse } from '../shim-protocol.js'
import { CLOUD_GRANT_SHORTCUT } from './announce.js'

const FAILED = 1
const MISUSED = 2

const USAGE =
  `Run it as \`${CLOUD_GRANT_SHORTCUT} request ENTITLEMENT DURATION JUSTIFICATION\` to ask for a ` +
  `Cloud Grant, or \`${CLOUD_GRANT_SHORTCUT} status GRANT\` to see how one stands.`

export function durationSeconds(written: string): number | null {
  const match = /^(\d+)(s|m|h)?$/.exec(written.trim())
  if (match === null) return null
  const unit = match[2] === 'h' ? 3600 : match[2] === 'm' ? 60 : 1
  return Number(match[1]) * unit
}

type Asked = { readonly request: Omit<ShimRequest, 'session'> } | { readonly misused: string }

export function askedBy(argv: readonly string[]): Asked {
  const [verb, ...rest] = argv
  if (verb === 'request') {
    const [entitlement, duration, ...words] = rest
    const justification = words.join(' ').trim()
    if (entitlement === undefined || duration === undefined || justification === '') {
      return { misused: `request takes an entitlement, a duration and a justification. ${USAGE}` }
    }
    const durationS = durationSeconds(duration)
    if (durationS === null) {
      return { misused: `${JSON.stringify(duration)} is not a duration; write it like 30m or 2h.` }
    }
    return {
      request: {
        operation: 'grant',
        credential: 'cloud',
        grant: { entitlement, durationS, justification },
      },
    }
  }
  if (verb === 'status') {
    const [grantName, ...extra] = rest
    if (grantName === undefined || extra.length > 0) {
      return { misused: `status takes exactly one grant. ${USAGE}` }
    }
    return { request: { operation: 'grant-status', credential: 'cloud', grantName } }
  }
  return { misused: USAGE }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  const asked = askedBy(argv)
  if ('misused' in asked) {
    err.write(`${CLOUD_GRANT_SHORTCUT}: ${asked.misused}\n`)
    return MISUSED
  }

  let answer: ShimResponse
  try {
    const shim = shimEnvironment(env)
    answer = await askMinter(shim.socketPath, { ...asked.request, session: shim.sessionId })
  } catch (error) {
    err.write(`${CLOUD_GRANT_SHORTCUT}: roma could not be reached: ${reasonOf(error)}\n`)
    return FAILED
  }

  const { grant } = answer
  if (grant === undefined) {
    err.write(`${CLOUD_GRANT_SHORTCUT}: ${answer.reason ?? 'roma gave no reason.'}\n`)
    return FAILED
  }
  out.write(
    `${JSON.stringify({
      grant: grant.name,
      state: grant.state,
      entitlement: grant.entitlement,
      approve: grant.approveAt,
    })}\n`,
  )
  return 0
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main()
}
