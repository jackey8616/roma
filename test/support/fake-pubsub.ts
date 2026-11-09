import type {
  PubSubMessage,
  PubSubSubscription,
} from '../../src/channels/google-chat/pubsub-transport.js'
import type { Settle } from '../../src/transport.js'

export class FakePubSubMessage implements PubSubMessage {
  readonly id: string
  readonly data: Uint8Array
  readonly settlements: Settle[] = []

  constructor(id: string, data: string) {
    this.id = id
    this.data = Buffer.from(data, 'utf8')
  }

  ack(): void {
    this.settlements.push('ack')
  }

  nack(): void {
    this.settlements.push('nack')
  }
}

export class FakeSubscription implements PubSubSubscription {
  closed = false

  #onMessage: ((message: PubSubMessage) => void) | null = null
  #onError: ((error: Error) => void) | null = null

  on(event: 'message', listener: (message: PubSubMessage) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'message' | 'error', listener: (arg: never) => void): this {
    if (event === 'message') this.#onMessage = listener as (message: PubSubMessage) => void
    else this.#onError = listener as (error: Error) => void
    return this
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }

  get listening(): boolean {
    return this.#onMessage !== null
  }

  publish(message: FakePubSubMessage): void {
    if (this.#onMessage === null) throw new Error('nothing is listening')
    this.#onMessage(message)
  }

  publishJson(payload: unknown, id = `msg-${Math.abs(Date.now() % 1000)}`): FakePubSubMessage {
    const message = new FakePubSubMessage(id, JSON.stringify(payload))
    this.publish(message)
    return message
  }

  fail(error: Error): void {
    if (this.#onError === null) throw new Error('nothing is listening for errors')
    this.#onError(error)
  }
}
