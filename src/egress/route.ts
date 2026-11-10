import { connect } from 'node:net'
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'
import { proxyUrl, type Gateway } from './egress-proxy.js'

export const LOOPBACK = '127.0.0.1,localhost,::1'

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'grpc_proxy'] as const
const NO_PROXY_VARS = ['NO_PROXY', 'no_proxy'] as const

export function routeThroughGateway(
  gateway: Gateway,
  env: Record<string, string | undefined> = process.env,
): void {
  const url = proxyUrl(gateway)
  for (const name of PROXY_VARS) env[name] = url
  for (const name of NO_PROXY_VARS) env[name] = LOOPBACK
  setGlobalDispatcher(new GatewayDispatcher(new ProxyAgent({ uri: url }), new Agent()))
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

class GatewayDispatcher extends Dispatcher {
  readonly #gateway: Dispatcher
  readonly #loopback: Dispatcher

  constructor(gateway: Dispatcher, loopback: Dispatcher) {
    super()
    this.#gateway = gateway
    this.#loopback = loopback
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandlers,
  ): boolean {
    const origin = options.origin === undefined ? null : new URL(String(options.origin))
    const direct = origin !== null && LOOPBACK_HOSTS.has(origin.hostname)
    return (direct ? this.#loopback : this.#gateway).dispatch(options, handler)
  }

  override async close(): Promise<void> {
    await Promise.all([this.#gateway.close(), this.#loopback.close()])
  }

  override async destroy(): Promise<void> {
    await Promise.all([this.#gateway.destroy(), this.#loopback.destroy()])
  }
}

export const DIRECT_PROBE = { host: 'api.anthropic.com', port: 443 } as const

export type DirectProbe = () => Promise<boolean>

export const probeDirectEgress: DirectProbe = () =>
  new Promise((resolve) => {
    const socket = connect(DIRECT_PROBE.port, DIRECT_PROBE.host)
    const settle = (reached: boolean) => {
      socket.destroy()
      resolve(reached)
    }
    socket.setTimeout(5000, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })

export class EgressRefused extends Error {
  constructor(gateway: string) {
    super(
      [
        'roma refused to start — it was told to send everything through an egress gateway, ' +
          'and the network lets it out without one.',
        `  It connected straight to ${DIRECT_PROBE.host}:${String(DIRECT_PROBE.port)} without ` +
          `going through ${gateway}. Anything roma can reach directly the agent can too, so the ` +
          'allowlist would hold nothing. Put roma on a network with no route out but the ' +
          'gateway, such as a Docker network created with --internal, as compose.yaml does.',
      ].join('\n'),
    )
    this.name = 'EgressRefused'
  }
}
