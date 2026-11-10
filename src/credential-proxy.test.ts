import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Credential } from './build-env.js'
import { CredentialProxy } from './credential-proxy.js'

const TOKEN: Credential = { kind: 'shared-window', oauthToken: 'sk-ant-oat01-REAL-TOKEN' }
const KEY: Credential = { kind: 'overflow', apiKey: 'sk-ant-api03-REAL-KEY' }

interface Received {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

let closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.reverse()) await close()
  closers = []
})

async function proxied(): Promise<{
  proxy: CredentialProxy
  received: Received[]
  release: () => void
}> {
  const received: Received[] = []
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const api: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: first\n\n')
      void gate.then(() => res.end('event: last\n\n'))
    })
  })
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise((resolve) => {
        api.closeAllConnections()
        api.close(() => resolve())
      }),
  )
  const { port } = api.address() as AddressInfo
  const proxy = await CredentialProxy.listen({ upstream: `http://127.0.0.1:${port}` })
  closers.push(() => proxy.close())
  return { proxy, received, release }
}

async function listening(handler: Parameters<typeof createServer>[1]): Promise<{ port: number }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return { port: (server.address() as AddressInfo).port }
}

async function rawRequest(baseUrl: string, target: string, auth: string): Promise<string> {
  const { port } = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n${auth}\r\nConnection: close\r\n\r\n`)
    })
    let reply = ''
    socket.on('data', (chunk) => (reply += chunk.toString()))
    socket.on('end', () => resolve(reply))
    socket.on('error', reject)
  })
}

describe('the credential proxy', () => {
  it('exchanges its own stand-in for the real credential, and nothing else [fence:credential-proxy-swaps-only-its-own-stand-in]', async () => {
    const why =
      'The proxy must send the real Shared Window token or Overflow key upstream only in place ' +
      'of a stand-in it handed out, in the header that kind travels in (ADR-0034). A request ' +
      'carrying anything else — no credential, a stand-in it never made, the other kind’s ' +
      'stand-in in the wrong header — is refused before it leaves, so the proxy cannot be ' +
      'used to attach roma’s credential to a request roma did not front.'
    const { proxy, received, release } = await proxied()
    release()
    const token = proxy.front(TOKEN)
    const key = proxy.front(KEY)

    const bearer = await fetch(`${token.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.standIn}` },
      body: '{}',
    })
    const apiKey = await fetch(`${key.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key.standIn },
      body: '{}',
    })
    const refused = await Promise.all(
      [
        {},
        { authorization: 'Bearer sk-ant-oat01-roma-stand-in-never-issued' },
        { authorization: `Bearer ${key.standIn}` },
        { 'x-api-key': token.standIn },
      ].map((headers) =>
        fetch(`${token.baseUrl}/v1/messages`, { method: 'POST', headers, body: '{}' }),
      ),
    )

    expect([bearer.status, apiKey.status], why).toEqual([200, 200])
    expect(
      received.map(({ headers }) => [headers['authorization'], headers['x-api-key']]),
      why,
    ).toEqual([
      ['Bearer sk-ant-oat01-REAL-TOKEN', undefined],
      [undefined, 'sk-ant-api03-REAL-KEY'],
    ])
    expect(
      refused.map(({ status }) => status),
      why,
    ).toEqual([401, 401, 401, 401])
  })

  it('forwards only to its upstream, whatever the request names [fence:credential-proxy-forwards-only-to-upstream]', async () => {
    const why =
      'A request target in absolute form, or one a URL parser reads as naming a host — //, or ' +
      'a backslash, which WHATWG URL treats as a slash — would be sent to that host with the ' +
      'real credential (ADR-0034). The proxy refuses every such target and sends nothing.'
    const { proxy, received, release } = await proxied()
    release()
    const token = proxy.front(TOKEN)
    const auth = `Authorization: Bearer ${token.standIn}`

    const attacker = await listening((req, res) => {
      stolen.push(req.headers.authorization ?? '')
      res.end()
    })
    const stolen: string[] = []
    const host = `127.0.0.1:${attacker.port}`

    const replies = await Promise.all(
      [
        `http://${host}/v1/messages`,
        `//${host}/v1/messages`,
        `/\\${host}/v1/messages`,
        `/\\/${host}/v1/messages`,
        `\\${host}/v1/messages`,
      ].map((target) => rawRequest(token.baseUrl, target, auth)),
    )

    for (const reply of replies) expect(reply, why).toMatch(/^HTTP\/1\.1 400/)
    expect(stolen, why).toEqual([])
    expect(received, why).toEqual([])
  })

  it('keeps the method, path, query and body, and sends no stand-in upstream', async () => {
    const { proxy, received, release } = await proxied()
    release()
    const token = proxy.front(TOKEN)

    await fetch(`${token.baseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.standIn}`, 'anthropic-beta': 'oauth-2025-04-20' },
      body: '{"model":"claude-sonnet-5"}',
    })

    expect(received).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/v1/messages?beta=true',
        body: '{"model":"claude-sonnet-5"}',
      }),
    ])
    expect(received[0]!.headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(JSON.stringify(received[0]!.headers)).not.toContain('stand-in')
  })

  it('streams the answer as it arrives rather than when it ends', async () => {
    const { proxy, release } = await proxied()
    const token = proxy.front(TOKEN)

    const response = await fetch(`${token.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.standIn}` },
      body: '{}',
    })
    const reader = response.body!.getReader()
    const first = await reader.read()
    release()
    let rest = ''
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      rest += new TextDecoder().decode(next.value)
    }

    expect(new TextDecoder().decode(first.value)).toBe('event: first\n\n')
    expect(rest).toBe('event: last\n\n')
  })

  it('ends the answer when the API drops it halfway [fence:credential-proxy-ends-a-dropped-answer]', async () => {
    const api = await listening((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: first\n\n', () => setTimeout(() => res.socket?.destroy(), 20))
    })
    const why =
      'When the API drops a streamed answer partway, the proxy must end the answer it is ' +
      'relaying too (ADR-0034). Otherwise claude waits on a stream that will never finish, and ' +
      'the Turn holds its concurrency slot until something else times it out.'
    const proxy = await CredentialProxy.listen({ upstream: `http://127.0.0.1:${api.port}` })
    closers.push(() => proxy.close())
    const token = proxy.front(TOKEN)

    const response = await fetch(`${token.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.standIn}` },
      body: '{}',
    })
    const ended = response.text().then(
      () => 'ended',
      () => 'ended',
    )
    const hung = new Promise((resolve) => setTimeout(() => resolve('hung'), 2_000))

    expect(await Promise.race([ended, hung]), why).toBe('ended')
  })

  it('answers 502 when the API cannot be reached', async () => {
    const proxy = await CredentialProxy.listen({ upstream: 'http://127.0.0.1:1' })
    closers.push(() => proxy.close())
    const token = proxy.front(TOKEN)

    const response = await fetch(`${token.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.standIn}` },
      body: '{}',
    })

    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('REAL-TOKEN')
  })

  it('makes a stand-in nobody else’s, and different on every front', async () => {
    const { proxy } = await proxied()

    const one = proxy.front(TOKEN)
    const two = proxy.front(TOKEN)

    expect(one.standIn).not.toBe(two.standIn)
    expect(one.standIn).not.toContain('REAL-TOKEN')
    expect(one.standIn.length).toBeGreaterThan(60)
  })
})
