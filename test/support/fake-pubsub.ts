import type {
  PubSubMessage,
  PubSubSubscription,
} from '../../src/channels/google-chat/pubsub-transport.js'
import type { Settle } from '../../src/transport.js'

/** One message a test pushes at the subscriber, and what roma said back. */
export class FakePubSubMessage implements PubSubMessage {
  readonly id: string
  readonly data: Uint8Array
  /** Every settlement, in order — a list rather than a flag, so a double ack shows. */
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

/**
 * A Pub/Sub subscription with the network taken out.
 *
 * The far side of the Transport seam: a test pushes bytes in and asserts on what
 * roma did with the message. Nothing here provisions or names a real
 * subscription, which is the point — roma reads a subscription somebody else
 * created, and that is as true in a test as in a deployment.
 */
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

  /** Whether anything is listening, which is what "subscribed" means here. */
  get listening(): boolean {
    return this.#onMessage !== null
  }

  /** Deliver one message, as the wire would. */
  publish(message: FakePubSubMessage): void {
    if (this.#onMessage === null) throw new Error('nothing is listening')
    this.#onMessage(message)
  }

  /** Deliver one JSON payload, and hand back the message roma will settle. */
  publishJson(payload: unknown, id = `msg-${Math.abs(Date.now() % 1000)}`): FakePubSubMessage {
    const message = new FakePubSubMessage(id, JSON.stringify(payload))
    this.publish(message)
    return message
  }

  /** Report a stream error, the way a broken connection does. */
  fail(error: Error): void {
    if (this.#onError === null) throw new Error('nothing is listening for errors')
    this.#onError(error)
  }
}
