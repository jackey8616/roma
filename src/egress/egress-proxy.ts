import { timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export interface Gateway {
  readonly url: string
  readonly token: string
}

export const GATEWAY_USER = 'roma'

export type Dial = (host: string, port: number) => Socket

export interface EgressProxyOptions {
  readonly allow: (host: string) => boolean
  readonly host?: string
  readonly port?: number
  readonly token?: string
  readonly via?: Gateway
  readonly dial?: Dial
}

export class EgressProxy {
  readonly #server: Server
  readonly #open = new Set<Duplex>()
  readonly url: string

  private constructor(server: Server, url: string) {
    this.#server = server
    this.url = url
  }

  static async listen({
    allow,
    host = '127.0.0.1',
    port = 0,
    token,
    via,
    dial = (target, targetPort) => connect(targetPort, target),
  }: EgressProxyOptions): Promise<EgressProxy> {
    const server = createServer((_req, res) => {
      res.writeHead(405, { 'content-type': 'text/plain' })
      res.end('roma egress forwards CONNECT only\n')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    const proxy = new EgressProxy(server, `http://${host}:${address.port}`)
    server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
      proxy.#track(client)
      client.on('error', () => client.destroy())
      const target = connectTarget(req.url ?? '')
      if (token !== undefined && !carries(req, token)) {
        answer(
          client,
          407,
          'Proxy Authentication Required',
          'Proxy-Authenticate: Basic realm="roma"',
        )
        return
      }
      if (target === null) {
        answer(client, 403, 'Forbidden')
        return
      }
      if (!allow(target)) {
        answer(client, 403, 'Forbidden')
        return
      }
      const opened =
        via === undefined
          ? Promise.resolve(proxy.#dialled(dial(target, 443)))
          : proxy.#through(via, target)
      opened.then(
        (upstream) => {
          if (client.destroyed) {
            upstream.destroy()
            return
          }
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length > 0) upstream.write(head)
          upstream.pipe(client)
          client.pipe(upstream)
          upstream.on('close', () => client.destroy())
          client.on('close', () => upstream.destroy())
        },
        () => answer(client, 502, 'Bad Gateway'),
      )
    })
    return proxy
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()))
    for (const socket of this.#open) socket.destroy()
    this.#server.closeAllConnections()
    await closed
  }

  #track(socket: Duplex): void {
    this.#open.add(socket)
    socket.on('close', () => this.#open.delete(socket))
  }

  #dialled(socket: Socket): Promise<Duplex> {
    this.#track(socket)
    return new Promise((resolve, reject) => {
      socket.once('connect', () => {
        socket.off('error', reject)
        socket.on('error', () => socket.destroy())
        resolve(socket)
      })
      socket.once('error', reject)
    })
  }

  #through(gateway: Gateway, target: string): Promise<Duplex> {
    const { hostname, port } = new URL(gateway.url)
    return new Promise((resolve, reject) => {
      const asked = httpRequest({
        hostname,
        port,
        method: 'CONNECT',
        path: `${target}:443`,
        headers: { host: `${target}:443`, 'proxy-authorization': basic(gateway.token) },
      })
      asked.once('connect', (res, socket, head) => {
        if (res.statusCode !== 200) {
          socket.destroy()
          reject(new Error(`the egress gateway answered ${String(res.statusCode)}`))
          return
        }
        this.#track(socket)
        socket.on('error', () => socket.destroy())
        if (head.length > 0) socket.unshift(head)
        resolve(socket)
      })
      asked.once('error', reject)
      asked.end()
    })
  }
}

export function proxyUrl(gateway: Gateway): string {
  const url = new URL(gateway.url)
  url.username = GATEWAY_USER
  url.password = encodeURIComponent(gateway.token)
  return url.href.replace(/\/$/, '')
}

export function basic(token: string): string {
  return `Basic ${Buffer.from(`${GATEWAY_USER}:${token}`).toString('base64')}`
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DNS_NAME = new RegExp(`^(?:${LABEL}\\.)+(?=[a-z0-9-]*[a-z])${LABEL}$`)

export function isDnsName(host: string): boolean {
  return host.length <= 253 && DNS_NAME.test(host)
}

export function connectTarget(authority: string): string | null {
  const match = /^([^:/\s]+):443$/.exec(authority)
  if (match === null) return null
  const host = (match[1] ?? '').toLowerCase().replace(/\.$/, '')
  return isDnsName(host) ? host : null
}

function carries(req: IncomingMessage, token: string): boolean {
  const presented = Buffer.from(req.headers['proxy-authorization'] ?? '')
  const expected = Buffer.from(basic(token))
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

function answer(client: Duplex, status: number, reason: string, header?: string): void {
  const extra = header === undefined ? '' : `${header}\r\n`
  client.end(`HTTP/1.1 ${String(status)} ${reason}\r\n${extra}Content-Length: 0\r\n\r\n`)
}
