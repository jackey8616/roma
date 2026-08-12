import type { ConnectGateway, GatewaySocket } from '../../src/channels/discord/gateway-transport.js'

/**
 * One Gateway connection with the network taken out.
 *
 * The far side of the Transport seam: a test pushes frames in and asserts on
 * what roma said back down the socket. Nothing here knows what an opcode means —
 * which is the point, since deciding that is the whole of what the Transport is
 * for.
 */
export class FakeGateway implements GatewaySocket {
  /** Where roma opened this one, which is how a resume is told from a first connection. */
  readonly url: string
  /** Every frame roma sent, parsed. Identify, resume and every heartbeat. */
  readonly sent: Record<string, unknown>[] = []
  /** The code roma closed with, or null while roma still holds it open. */
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

  /**
   * roma asking to close, which is not the same event as being closed.
   *
   * Deliberately silent: closing a real socket is a handshake, so the `close`
   * event arrives later — after roma has already moved on, which is exactly the
   * case a Transport can get wrong. A test that wants the far side to answer
   * calls `hangUp`.
   */
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

  /** Whether anything is listening, which is what "connected" means here. */
  get listening(): boolean {
    return this.#onMessage !== null
  }

  /** Every frame roma sent with one opcode, oldest first. */
  sentWith(op: number): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame['op'] === op)
  }

  /** Deliver one payload, as the wire would. */
  push(payload: unknown): void {
    this.pushFrame(JSON.stringify(payload))
  }

  /** Deliver bytes that may not be a payload at all. */
  pushFrame(frame: string): void {
    if (this.#onMessage === null) throw new Error('nothing is listening')
    this.#onMessage(frame)
  }

  /**
   * The connection ending, however it ended.
   *
   * Discord closing it, a connection breaking, or the handshake behind a `close`
   * roma asked for finally completing — which is why this can be called on a
   * socket roma has already left behind.
   */
  hangUp(code: number): void {
    this.closedWith ??= code
    this.#onClose?.(code)
  }

  /** Fault the socket, which on a real one is followed by a close. */
  fail(error: Error): void {
    if (this.#onError === null) throw new Error('nothing is listening for errors')
    this.#onError(error)
  }
}

/**
 * Every connection roma has opened, in order.
 *
 * A reconnection is a *new* socket rather than a revived one, so a test that
 * wants to assert on a resume has to be able to see both — the frames roma sent
 * on the first connection are still there to compare against.
 */
export class FakeGatewayNetwork {
  readonly sockets: FakeGateway[] = []

  readonly connect: ConnectGateway = (url) => {
    const socket = new FakeGateway(url)
    this.sockets.push(socket)
    return socket
  }

  /** The connection roma is on now. */
  get socket(): FakeGateway {
    const socket = this.sockets.at(-1)
    if (socket === undefined) throw new Error('roma has opened no connection')
    return socket
  }
}
