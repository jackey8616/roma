import type { ConnectGateway, GatewaySocket } from '../../src/channels/discord/gateway-transport.js'

export class FakeGateway implements GatewaySocket {
  readonly url: string
  readonly sent: Record<string, unknown>[] = []
  closedWith: number | null = null

  #onMessage: ((frame: string) => void) | null = null
  #onClose: ((code: number) => void) | null = null
  #onError: ((error: Error) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  send(frame: string): void {
    this.sent.push(JSON.parse(frame) as Record<string, unknown>)
  }

  close(code: number): void {
    this.closedWith ??= code
  }

  on(event: 'message', listener: (frame: string) => void): void
  on(event: 'close', listener: (code: number) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'message' | 'close' | 'error', listener: (arg: never) => void): void {
    if (event === 'message') this.#onMessage = listener as (frame: string) => void
    else if (event === 'close') this.#onClose = listener as (code: number) => void
    else this.#onError = listener as (error: Error) => void
  }

  get listening(): boolean {
    return this.#onMessage !== null
  }

  sentWith(op: number): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame['op'] === op)
  }

  push(payload: unknown): void {
    this.pushFrame(JSON.stringify(payload))
  }

  pushFrame(frame: string): void {
    if (this.#onMessage === null) throw new Error('nothing is listening')
    this.#onMessage(frame)
  }

  hangUp(code: number): void {
    this.closedWith ??= code
    this.#onClose?.(code)
  }

  fail(error: Error): void {
    if (this.#onError === null) throw new Error('nothing is listening for errors')
    this.#onError(error)
  }
}

export class FakeGatewayNetwork {
  readonly sockets: FakeGateway[] = []

  readonly connect: ConnectGateway = (url) => {
    const socket = new FakeGateway(url)
    this.sockets.push(socket)
    return socket
  }

  get socket(): FakeGateway {
    const socket = this.sockets.at(-1)
    if (socket === undefined) throw new Error('roma has opened no connection')
    return socket
  }
}
