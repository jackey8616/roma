/**
 * The two ways a Delivery can be settled. One type for the port, the subscriber
 * and both doubles, so none of them spells the pair differently.
 */
export type Settle = 'ack' | 'nack'

/**
 * A Delivery. `event` is passed along unread to the Adapter that knows how to
 * read it.
 */
export interface Delivery<Event = unknown> {
  /**
   * The Transport's own name for this delivery, the same on every redelivery of
   * it: the only thing that tells a redelivery from a second message saying the
   * same words.
   */
  readonly id: string
  readonly event: Event
  /**
   * Finished with it. The Transport need not deliver it again.
   *
   * Said only once roma has answered the Conversation, so a crash mid-Task
   * leaves the event to be delivered again rather than lost unanswered.
   */
  ack(): void | Promise<void>
  /**
   * Not finished with it, and roma is not going to be.
   *
   * For the failures another attempt could get past — the Channel being
   * unreachable, most of all. Not for an event roma cannot read. Enforced by
   * `fence:serve-unreadable-is-finished-and-logged`.
   *
   * **What it buys may be nothing.** A Transport with nowhere to hand a
   * Delivery back to does nothing here, and the work is lost.
   */
  nack(): void | Promise<void>
}

/**
 * What roma does with one delivery. Resolves when the Delivery has been
 * settled, and never rejects: a Transport may treat a rejection as a bug.
 */
export type Receiver<Event = unknown> = (delivery: Delivery<Event>) => Promise<void>

/**
 * A Transport, as much of it as roma uses. Neither method provisions anything:
 * the topic, subscription and credentials are configuration, there before roma
 * starts and after it stops.
 */
export interface Transport<Event = unknown> {
  /**
   * Start delivering events to `receiver`.
   *
   * Resolves once roma has subscribed, after which events are roma's. Not a
   * promise that a stream is open yet; only that nothing was subscribed before
   * this was called.
   */
  receive(receiver: Receiver<Event>): Promise<void>
  /**
   * Stop delivering, and settle whatever is in flight.
   *
   * Resolves when nothing more will reach the receiver, without waiting for
   * what is in flight: a Delivery caught mid-flight is handed back, by `serve`.
   * A Transport that also hands them back on close is harmlessly doing it twice.
   */
  close(): Promise<void>
}
