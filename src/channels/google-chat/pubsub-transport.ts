import { reasonOf, writeToStderr, type OperatorLog } from '../../operator-log.js'
import type { Delivery, Receiver, Transport } from '../../transport.js'
import type { ChatEvent } from './chat-events.js'

/**
 * As much of one Pub/Sub message as roma reads.
 *
 * Four members out of a class with a good deal more on it. Narrow on purpose:
 * what the subscriber needs is an identity, some bytes, and the two things it
 * can say back — and a port shaped like the library would make the double a test
 * needs most of the library.
 */
export interface PubSubMessage {
  /**
   * Pub/Sub's own id for the message, which is the same on every redelivery of
   * it.
   *
   * The property the subscriber's in-flight check rests on. An id minted on
   * arrival would be different every time and would catch nothing.
   */
  readonly id: string
  /** The event as it was published: JSON, UTF-8. */
  readonly data: Uint8Array
  ack(): void
  nack(): void
}

/** As much of a Pub/Sub subscription as roma uses. */
export interface PubSubSubscription {
  on(event: 'message', listener: (message: PubSubMessage) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  close(): Promise<void>
}

/** One thing the subscriber did that no Conversation will ever hear about. */
export type PubSubLogRecord =
  | {
      /**
       * A message whose bytes are not an event.
       *
       * Something other than Chat is publishing to this subscription, or Chat
       * has changed what it publishes. Finished with and dropped, so this record
       * is the only trace it leaves.
       */
      readonly event: 'pubsub-undecodable'
      readonly messageId: string
      readonly reason: string
    }
  | {
      /**
       * The subscription itself faulted — a reset stream, an expired lease
       * renewal.
       *
       * Written down rather than acted on: recovering is the client library's
       * business and it reconnects on its own. What this exists for is the case
       * where it does not, so that "roma has gone quiet" has something behind it.
       */
      readonly event: 'pubsub-error'
      readonly reason: string
    }
  | {
      /**
       * The receiver rejected, which it is not supposed to do.
       *
       * A bug on roma's side rather than a fact about the message, and the
       * message is handed back so that it is not lost to one.
       */
      readonly event: 'pubsub-unreceived'
      readonly messageId: string
      readonly reason: string
    }

export interface PubSubTransportOptions {
  /**
   * The subscription to read, already opened.
   *
   * Handed in rather than created here, and that is the shape of ADR-0004's
   * "no receiver of our own": Chat publishes to a topic somebody provisioned,
   * roma reads a subscription somebody provisioned, and the flow-control and
   * lease settings that govern how it is read are the deployment's to choose.
   * roma creates neither and would not know what to create them as.
   */
  readonly subscription: PubSubSubscription
  readonly log?: OperatorLog<PubSubLogRecord>
}

/**
 * Google Chat's inbound path: a Pub/Sub subscription, read.
 *
 * ADR-0004's whole inbound decision, and it is nearly empty by design — Chat
 * publishes its events to a topic directly, so roma needs no HTTPS receiver, no
 * open port, and none of the ~30-second webhook deadline that a minutes-long Turn
 * could never meet. What is left is decoding and settling.
 *
 * The lease is the part worth understanding. A message stays unsettled for as
 * long as the Task it carries takes to answer, which is minutes — the client
 * library keeps extending its deadline meanwhile, and a roma that dies mid-Task
 * therefore leaves the message on the subscription to be delivered again rather
 * than settled into nothing. That is the trade the acceptance criterion asks
 * for, and it is at-least-once in both directions: the same event can arrive
 * twice, which is why a Delivery carries Pub/Sub's own id.
 */
export class PubSubTransport implements Transport<ChatEvent> {
  readonly #subscription: PubSubSubscription
  readonly #log: OperatorLog<PubSubLogRecord>

  constructor({ subscription, log }: PubSubTransportOptions) {
    this.#subscription = subscription
    this.#log = log ?? writeToStderr
  }

  receive(receiver: Receiver<ChatEvent>): Promise<void> {
    this.#subscription.on('message', (message) => {
      // Detached on purpose: Pub/Sub's listener is synchronous, and each message
      // is answered on its own timescale. Awaiting one here would serialise
      // every Conversation behind whichever Task is slowest, which is what the
      // Task Queue exists to decide instead.
      void this.#take(message, receiver)
    })
    this.#subscription.on('error', (error) => {
      // Never thrown on. A listener that threw would be an unhandled error
      // taking the process down over a network blip the library is already
      // reconnecting from.
      this.#log({ event: 'pubsub-error', reason: reasonOf(error) })
    })
    return Promise.resolve()
  }

  close(): Promise<void> {
    return this.#subscription.close()
  }

  async #take(message: PubSubMessage, receiver: Receiver<ChatEvent>): Promise<void> {
    const event = this.#decode(message)
    // Finished with and dropped. Bytes that are not an event will not become one
    // on the next attempt, so handing this back would make one bad message
    // something the subscriber trips over on every pass for as long as the
    // subscription keeps it.
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
      // The receiver is not supposed to reject — settling is its decision, and
      // it knows more about whether another attempt would help than this side
      // does. Reaching here is a bug, and the message is handed back rather than
      // left to sit until its lease expires.
      this.#log({ event: 'pubsub-unreceived', messageId: message.id, reason: reasonOf(error) })
      message.nack()
    }
  }

  /**
   * The Chat event inside one message, or null if there is not one.
   *
   * Chat publishes the interaction event as JSON in the message body, so this is
   * the whole of the envelope. Anything that is not a JSON object is not an
   * event: an Adapter reads fields off one, and a bare string, a list or a null
   * has none to read.
   */
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
