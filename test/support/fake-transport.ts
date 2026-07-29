import type { Delivery, Receiver, Settle, Transport } from '../../src/transport.js'

/** How one Delivery was settled, in the order roma settled them. */
export interface Settlement {
  readonly id: string
  readonly settle: Settle
}

/**
 * A Transport a test drives by hand.
 *
 * The far side of the ingress seam: an event goes in and what comes out is
 * whether roma finished with it or handed it back, with no queue, no credential
 * and no network. `deliver` resolves only once roma has settled the Delivery,
 * which is what lets a test assert on the *timing* of a settlement rather than
 * merely on its existence — the acceptance criterion this exists for is that a
 * crash mid-Task does not lose the message, and that is a claim about when the
 * settling happens.
 */
export class FakeTransport<Event = unknown> implements Transport<Event> {
  readonly settlements: Settlement[] = []
  /** Whether `close` has been called, which is how a test sees a clean shutdown. */
  closed = false

  #receiver: Receiver<Event> | null = null
  #delivered = 0

  /** Whether roma is accepting events at all. */
  get receiving(): boolean {
    return this.#receiver !== null
  }

  /** Every Delivery roma finished with, in order. */
  get acked(): string[] {
    return this.settlements.filter(({ settle }) => settle === 'ack').map(({ id }) => id)
  }

  /** Every Delivery roma handed back, in order. */
  get nacked(): string[] {
    return this.settlements.filter(({ settle }) => settle === 'nack').map(({ id }) => id)
  }

  receive(receiver: Receiver<Event>): Promise<void> {
    this.#receiver = receiver
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    this.#receiver = null
    return Promise.resolve()
  }

  /**
   * Deliver one event. Resolves when roma has settled it.
   *
   * The id defaults to a fresh one, and a test that passes the same id twice is
   * doing exactly what a queue does after a lease expires.
   */
  deliver(event: Event, id = `delivery-${(this.#delivered += 1)}`): Promise<void> {
    const receiver = this.#receiver
    if (receiver === null) throw new Error('nothing is receiving')
    const delivery: Delivery<Event> = {
      id,
      event,
      ack: () => {
        this.settlements.push({ id, settle: 'ack' })
      },
      nack: () => {
        this.settlements.push({ id, settle: 'nack' })
      },
    }
    return receiver(delivery)
  }
}
