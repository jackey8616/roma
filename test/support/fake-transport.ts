import type { Delivery, Receiver, Settle, Transport } from '../../src/transport.js'

export interface Settlement {
  readonly id: string
  readonly settle: Settle
}

export class FakeTransport<Event = unknown> implements Transport<Event> {
  readonly settlements: Settlement[] = []
  closed = false

  #receiver: Receiver<Event> | null = null
  #delivered = 0

  get receiving(): boolean {
    return this.#receiver !== null
  }

  get acked(): string[] {
    return this.settlements.filter(({ settle }) => settle === 'ack').map(({ id }) => id)
  }

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
