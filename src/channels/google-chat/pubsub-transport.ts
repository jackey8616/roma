import { reasonOf, writeToStderr, type OperatorLog } from '../../operator-log.js'
import type { Delivery, Receiver, Transport } from '../../transport.js'
import type { ChatEvent } from './chat-events.js'

export interface PubSubMessage {
  readonly id: string
  readonly data: Uint8Array
  ack(): void
  nack(): void
}

export interface PubSubSubscription {
  on(event: 'message', listener: (message: PubSubMessage) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  close(): Promise<void>
}

export type PubSubLogRecord =
  | {
      readonly event: 'pubsub-undecodable'
      readonly messageId: string
      readonly reason: string
    }
  | {
      readonly event: 'pubsub-error'
      readonly reason: string
    }
  | {
      readonly event: 'pubsub-unreceived'
      readonly messageId: string
      readonly reason: string
    }

export interface PubSubTransportOptions {
  readonly subscription: PubSubSubscription
  readonly log?: OperatorLog<PubSubLogRecord>
}

export class PubSubTransport implements Transport<ChatEvent> {
  readonly #subscription: PubSubSubscription
  readonly #log: OperatorLog<PubSubLogRecord>

  constructor({ subscription, log }: PubSubTransportOptions) {
    this.#subscription = subscription
    this.#log = log ?? writeToStderr
  }

  receive(receiver: Receiver<ChatEvent>): Promise<void> {
    this.#subscription.on('message', (message) => {
      void this.#take(message, receiver)
    })
    this.#subscription.on('error', (error) => {
      this.#log({ event: 'pubsub-error', reason: reasonOf(error) })
    })
    return Promise.resolve()
  }

  close(): Promise<void> {
    return this.#subscription.close()
  }

  async #take(message: PubSubMessage, receiver: Receiver<ChatEvent>): Promise<void> {
    const event = this.#decode(message)
    if (event === null) {
      message.ack()
      return
    }

    const delivery: Delivery<ChatEvent> = {
      id: message.id,
      event,
      ack: () => message.ack(),
      nack: () => message.nack(),
    }
    try {
      await receiver(delivery)
    } catch (error) {
      this.#log({ event: 'pubsub-unreceived', messageId: message.id, reason: reasonOf(error) })
      message.nack()
    }
  }

  #decode(message: PubSubMessage): ChatEvent | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(message.data).toString('utf8'))
    } catch (error) {
      this.#log({ event: 'pubsub-undecodable', messageId: message.id, reason: reasonOf(error) })
      return null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.#log({
        event: 'pubsub-undecodable',
        messageId: message.id,
        reason: `the message is ${describe(parsed)}, not a Chat event`,
      })
      return null
    }
    return parsed as ChatEvent
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  return `a ${typeof value}`
}
