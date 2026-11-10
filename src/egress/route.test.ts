import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { PubSub } from '@google-cloud/pubsub'
import { Gaxios } from 'gaxios'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CredentialProxy } from '../credential-proxy.js'
import { EgressProxy } from './egress-proxy.js'
import { routeThroughGateway } from './route.js'

const TOKEN = 'g'.repeat(64)
const VARS = ['HTTPS_PROXY', 'https_proxy', 'grpc_proxy', 'NO_PROXY', 'no_proxy'] as const

let sink: Server
let gateway: EgressProxy
const dialled: string[] = []
const saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))
const dispatcher = getGlobalDispatcher()

beforeAll(async () => {
  sink = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve))
  const { port } = sink.address() as AddressInfo
  gateway = await EgressProxy.listen({
    allow: () => true,
    token: TOKEN,
    dial: (host) => {
      dialled.push(host)
      return connect(port, '127.0.0.1')
    },
  })
  routeThroughGateway({ url: gateway.url, token: TOKEN })
})

afterAll(async () => {
  setGlobalDispatcher(dispatcher)
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  await gateway.close()
  await new Promise<void>((resolve) => sink.close(() => resolve()))
})

async function arrived(host: string): Promise<void> {
  for (let waited = 0; waited < 5000 && !dialled.includes(host); waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(dialled).toContain(host)
}

describe('roma’s own traffic behind a gateway [fence:roma-reaches-out-only-through-the-gateway]', () => {
  const why =
    'roma’s network has no route out but the gateway, so every client roma uses must find it: ' +
    'a client that does not is a Channel or a Reach that stops working only in production.'

  it('sends fetch through it, which the minters and Discord’s API use', async () => {
    await fetch('https://fetch.roma.test/').catch(() => null)
    await arrived('fetch.roma.test')
  })

  it('sends a WebSocket through it, which Discord’s gateway uses', async () => {
    await new Promise<void>((resolve) => {
      const socket = new WebSocket('wss://websocket.roma.test/')
      socket.onerror = () => resolve()
      socket.onclose = () => resolve()
    })
    await arrived('websocket.roma.test')
  })

  it('sends gaxios through it, which Google Chat and Google’s token exchange use', async () => {
    await new Gaxios().request({ url: 'https://gaxios.roma.test/', retry: false }).catch(() => null)
    await arrived('gaxios.roma.test')
  })

  it('sends gRPC through it, which Pub/Sub uses', async () => {
    const pubsub = new PubSub({
      projectId: 'roma-test',
      credentials: { client_email: 'roma@roma.test', private_key: 'not-a-key' },
    })
    void pubsub
      .topic('t')
      .exists()
      .catch(() => null)
    await arrived('pubsub.googleapis.com')
    await pubsub.close()
  })

  it('sends the credential proxy through it, carrying the gateway’s token', async () => {
    const proxy = await CredentialProxy.listen({
      upstream: 'https://anthropic.roma.test',
      via: { url: gateway.url, token: TOKEN },
    })
    const fronted = proxy.front({ kind: 'shared-window', oauthToken: 'sk-ant-oat01-REAL' })
    await fetch(`${fronted.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fronted.standIn}` },
      body: '{}',
    }).catch(() => null)
    await arrived('anthropic.roma.test')
    await proxy.close()
  })

  it('leaves loopback alone, where the credential proxy and the agent’s proxy listen', () => {
    expect(process.env['NO_PROXY'], why).toBe('127.0.0.1,localhost,::1')
    expect(process.env['HTTPS_PROXY'], why).toBe(gateway.url.replace('//', `//roma:${TOKEN}@`))
  })
})
