import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EgressProxy } from './egress-proxy.js'

export const GATEWAY_PORT = 3128

export interface GatewayEnv {
  readonly token: string
  readonly port: number
}

export function readGatewayEnv(env: Readonly<Record<string, string | undefined>>): GatewayEnv {
  const file = env['ROMA_EGRESS_TOKEN_FILE']
  if (file === undefined || file === '') {
    throw new Error('the egress gateway needs ROMA_EGRESS_TOKEN_FILE, the token roma holds too')
  }
  const token = readFileSync(file, 'utf8').trim()
  if (token.length < 32 || /\s/.test(token)) {
    throw new Error(
      `ROMA_EGRESS_TOKEN_FILE (${file}) does not hold one token of at least 32 characters`,
    )
  }
  const port = Number(env['ROMA_EGRESS_PORT'] ?? GATEWAY_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ROMA_EGRESS_PORT is "${String(env['ROMA_EGRESS_PORT'])}", which is not a port`)
  }
  return { token, port }
}

export function startGateway({ token, port }: GatewayEnv): Promise<EgressProxy> {
  return EgressProxy.listen({ allow: () => true, host: '0.0.0.0', port, token })
}

async function main(): Promise<void> {
  let gateway: EgressProxy
  try {
    gateway = await startGateway(readGatewayEnv(process.env))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
  process.stderr.write(`${JSON.stringify({ event: 'egress-gateway', url: gateway.url })}\n`)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void gateway.close().then(() => process.exit(0))
    })
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main()
}
