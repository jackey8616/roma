export type Settle = 'ack' | 'nack'

export interface Delivery<Event = unknown> {
  readonly id: string
  readonly event: Event
  ack(): void | Promise<void>
  nack(): void | Promise<void>
}

export type Receiver<Event = unknown> = (delivery: Delivery<Event>) => Promise<void>

export interface Transport<Event = unknown> {
  receive(receiver: Receiver<Event>): Promise<void>
  close(): Promise<void>
}
