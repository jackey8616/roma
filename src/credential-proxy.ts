import { randomBytes } from 'node:crypto'
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { Credential, CredentialKind } from './build-env.js'
import { proxyUrl, type Gateway } from './egress/egress-proxy.js'

export const ANTHROPIC_API = 'https://api.anthropic.com'

declare const FRONTED: unique symbol

export interface Fronted {
  readonly kind: CredentialKind
  readonly standIn: string
  readonly baseUrl: string
  readonly [FRONTED]: true
}

export interface CredentialProxyOptions {
  readonly upstream?: string
  readonly via?: Gateway
}

export class CredentialProxy {
  readonly #server: Server
  readonly #upstream: URL
  readonly #agent: HttpAgent | HttpsAgent | HttpsProxyAgent<string>
  readonly #baseUrl: string
  readonly #bearers = new Map<string, string>()
  readonly #apiKeys = new Map<string, string>()

  private constructor(server: Server, upstream: URL, baseUrl: string, via: Gateway | undefined) {
    this.#server = server
    this.#upstream = upstream
    this.#baseUrl = baseUrl
    this.#agent =
      via !== undefined
        ? new HttpsProxyAgent(proxyUrl(via), { keepAlive: true })
        : upstream.protocol === 'https:'
          ? new HttpsAgent({ keepAlive: true })
          : new HttpAgent({ keepAlive: true })
    server.on('request', (req, res) => this.#forward(req, res))
  }

  static async listen({
    upstream = ANTHROPIC_API,
    via,
  }: CredentialProxyOptions = {}): Promise<CredentialProxy> {
    const target = new URL(upstream)
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new Error(`the credential proxy cannot forward to ${target.protocol} URLs`)
    }
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const { port } = server.address() as AddressInfo
    return new CredentialProxy(server, target, `http://127.0.0.1:${port}`, via)
  }

  front(credential: Credential): Fronted {
    const kind = credential.kind
    const secret = kind === 'shared-window' ? credential.oauthToken : credential.apiKey
    const standIn = `${STAND_IN_PREFIX[kind]}${randomBytes(32).toString('base64url')}`
    ;(kind === 'shared-window' ? this.#bearers : this.#apiKeys).set(standIn, secret)
    return { kind, standIn, baseUrl: this.#baseUrl } as Fronted
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()))
    this.#server.closeAllConnections()
    this.#agent.destroy()
    await closed
  }

  #forward(req: IncomingMessage, res: ServerResponse): void {
    const path = req.url ?? ''
    if (!ORIGIN_FORM.test(path)) {
      refuse(res, 400, 'the credential proxy only forwards paths')
      return
    }

    const headers = this.#exchange(req.headers)
    if (headers === null) {
      refuse(res, 401, 'the credential proxy does not recognise this credential')
      return
    }

    const { protocol, hostname, port, host, pathname } = this.#upstream
    headers['host'] = host
    const send = protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = send(
      {
        protocol,
        hostname,
        port,
        path: pathname.replace(/\/$/, '') + path,
        method: req.method,
        headers,
        agent: this.#agent,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.statusMessage, withoutHopByHop(reply.headers))
        reply.on('close', () => {
          if (!reply.complete) res.destroy()
        })
        reply.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) refuse(res, 502, 'the credential proxy could not reach the API')
      else res.destroy()
    })
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    req.pipe(upstream)
  }

  #exchange(incoming: IncomingHttpHeaders): OutgoingHttpHeaders | null {
    const headers: OutgoingHttpHeaders = withoutHopByHop(incoming)
    const bearer = /^Bearer (.+)$/.exec(incoming.authorization ?? '')?.[1]
    const apiKey = incoming['x-api-key']
    const realBearer = bearer === undefined ? undefined : this.#bearers.get(bearer)
    const realKey = typeof apiKey === 'string' ? this.#apiKeys.get(apiKey) : undefined

    delete headers['authorization']
    delete headers['x-api-key']
    if (realBearer !== undefined) headers['authorization'] = `Bearer ${realBearer}`
    else if (realKey !== undefined) headers['x-api-key'] = realKey
    else return null
    return headers
  }
}

const ORIGIN_FORM = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/

const STAND_IN_PREFIX: Readonly<Record<CredentialKind, string>> = {
  'shared-window': 'sk-ant-oat01-roma-stand-in-',
  overflow: 'sk-ant-api03-roma-stand-in-',
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])

function withoutHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const kept: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) kept[name] = value
  }
  return kept
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'roma_credential_proxy', message } }))
}
