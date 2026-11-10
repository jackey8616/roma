import { request } from 'node:http'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { agentAllowlist, allows, AGENT_ALLOWLIST } from './allowlist.js'
import { basic, EgressProxy, proxyUrl, type Dial } from './egress-proxy.js'

const TOKEN = 't'.repeat(64)

let closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.reverse()) await close()
  closers = []
})

async function echo(): Promise<number> {
  const server: Server = createServer((socket) => socket.pipe(socket))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  closers.push(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  )
  return (server.address() as AddressInfo).port
}

async function dialler(): Promise<{ dial: Dial; dialled: string[] }> {
  const port = await echo()
  const dialled: string[] = []
  return {
    dialled,
    dial: (host, targetPort) => {
      dialled.push(`${host}:${String(targetPort)}`)
      return connect(port, '127.0.0.1')
    },
  }
}

const refusingDial: Dial = () => {
  throw new Error('dialled directly')
}

async function listening(options: Parameters<typeof EgressProxy.listen>[0]): Promise<EgressProxy> {
  const proxy = await EgressProxy.listen(options)
  closers.push(() => proxy.close())
  return proxy
}

interface Answer {
  readonly status: number
  readonly echoed: string | null
}

function ask(proxy: string, target: string, authorization?: string): Promise<Answer> {
  const { hostname, port } = new URL(proxy)
  return new Promise((resolve, reject) => {
    const asked = request({
      hostname,
      port,
      method: 'CONNECT',
      path: target,
      headers: authorization === undefined ? {} : { 'proxy-authorization': authorization },
    })
    asked.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        resolve({ status: res.statusCode ?? 0, echoed: null })
        return
      }
      socket.once('data', (chunk: Buffer) => {
        socket.destroy()
        resolve({ status: 200, echoed: chunk.toString() })
      })
      socket.write('hello through the tunnel')
    })
    asked.once('error', reject)
    asked.end()
  })
}

function plainGet(proxy: string): Promise<number> {
  const { hostname, port } = new URL(proxy)
  return new Promise((resolve, reject) => {
    const asked = request({ hostname, port, path: 'http://example.com/', method: 'GET' }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    asked.once('error', reject)
    asked.end()
  })
}

describe('EgressProxy', () => {
  it('tunnels to a listed host on 443', async () => {
    const { dial, dialled } = await dialler()
    const proxy = await listening({ allow: allows(['registry.npmjs.org']), dial })

    expect(await ask(proxy.url, 'Registry.NPMjs.org:443')).toEqual({
      status: 200,
      echoed: 'hello through the tunnel',
    })
    expect(dialled).toEqual(['registry.npmjs.org:443'])
  })

  it('refuses a host the allowlist does not name, and dials nothing [fence:egress-refuses-an-unlisted-host]', async () => {
    const { dial, dialled } = await dialler()
    const proxy = await listening({ allow: allows([...AGENT_ALLOWLIST]), dial })

    for (const target of ['httpbin.org:443', 'example.com:443', 'evilregistry.npmjs.org:443']) {
      expect((await ask(proxy.url, target)).status, target).toBe(403)
    }
    expect(dialled).toEqual([])
  })

  it('connects only to a host name on port 443, whatever the allowlist says [fence:egress-connects-only-to-names-on-443]', async () => {
    const why =
      'An address skips the allowlist, which names hosts; a single label such as localhost or ' +
      'the gateway itself names something inside the deployment; any port but 443 is not the ' +
      'TLS the allowlist was written for.'
    const { dial, dialled } = await dialler()
    const proxy = await listening({ allow: () => true, dial })

    for (const target of [
      '93.184.215.14:443',
      '127.0.0.1:443',
      '[::1]:443',
      '0x7f000001:443',
      'localhost:443',
      'egress:443',
      'example.com:80',
      'example.com:22',
      'example.com',
      'example.com:443/path',
      'user@example.com:443',
    ]) {
      expect((await ask(proxy.url, target)).status, `${target}: ${why}`).toBe(403)
    }
    expect(dialled).toEqual([])
  })

  it('forwards nothing but CONNECT', async () => {
    const { dial, dialled } = await dialler()
    const proxy = await listening({ allow: () => true, dial })

    expect(await plainGet(proxy.url)).toBe(405)
    expect(dialled).toEqual([])
  })

  it('as the gateway, refuses whoever does not carry its token [fence:egress-gateway-refuses-without-its-token]', async () => {
    const { dial, dialled } = await dialler()
    const gateway = await listening({ allow: () => true, token: TOKEN, dial })

    expect((await ask(gateway.url, 'example.com:443')).status).toBe(407)
    expect((await ask(gateway.url, 'example.com:443', basic('x'.repeat(64)))).status).toBe(407)
    expect((await ask(gateway.url, 'example.com:443', `Bearer ${TOKEN}`)).status).toBe(407)
    expect(dialled).toEqual([])

    expect((await ask(gateway.url, 'example.com:443', basic(TOKEN))).status).toBe(200)
    expect(dialled).toEqual(['example.com:443'])
  })

  it('as the agent’s proxy, reaches a listed host only through the gateway, carrying its token [fence:egress-agent-proxy-goes-only-through-the-gateway]', async () => {
    const { dial, dialled } = await dialler()
    const gateway = await listening({ allow: () => true, token: TOKEN, dial })
    const agent = await listening({
      allow: allows(['registry.npmjs.org']),
      via: { url: gateway.url, token: TOKEN },
      dial: refusingDial,
    })

    expect(await ask(agent.url, 'registry.npmjs.org:443')).toEqual({
      status: 200,
      echoed: 'hello through the tunnel',
    })
    expect((await ask(agent.url, 'example.com:443')).status).toBe(403)
    expect(dialled).toEqual(['registry.npmjs.org:443'])
  })

  it('as the agent’s proxy, answers 502 when the gateway refuses it', async () => {
    const { dial } = await dialler()
    const gateway = await listening({ allow: () => true, token: TOKEN, dial })
    const agent = await listening({
      allow: allows(['registry.npmjs.org']),
      via: { url: gateway.url, token: 'w'.repeat(64) },
      dial: refusingDial,
    })

    expect((await ask(agent.url, 'registry.npmjs.org:443')).status).toBe(502)
  })

  it('puts the token in a proxy URL as roma’s password, escaped', () => {
    expect(proxyUrl({ url: 'http://egress:3128', token: 'a/b@c' })).toBe(
      'http://roma:a%2Fb%40c@egress:3128',
    )
  })
})

describe('the agent’s allowlist', () => {
  it('matches a name exactly, or a *. pattern on its subdomains only', () => {
    const allowed = allows(['registry.npmjs.org', '*.googleapis.com'])

    expect(allowed('registry.npmjs.org')).toBe(true)
    expect(allowed('storage.googleapis.com')).toBe(true)
    expect(allowed('npmjs.org')).toBe(false)
    expect(allowed('googleapis.com')).toBe(false)
    expect(allowed('evilgoogleapis.com')).toBe(false)
    expect(allowed('registry.npmjs.org.attacker.example')).toBe(false)
  })

  it('is the registry, and what each configured Reach and the operator add, once each', () => {
    expect(agentAllowlist()).toEqual([...AGENT_ALLOWLIST])
    expect(agentAllowlist(['a.example', '*.b.example'], [], ['a.example', 'pypi.org'])).toEqual([
      ...AGENT_ALLOWLIST,
      'a.example',
      '*.b.example',
      'pypi.org',
    ])
  })
})
