/**
 * The two ways a Delivery can be settled.
 *
 * Its own type because four places name the pair — the port, the subscriber, and
 * both doubles — and a fifth spelling of `'ack' | 'nack'` is how one of them
 * comes to mean something slightly different from the others.
 */
export type Settle = 'ack' | 'nack'

/**
 * One event as the Transport handed it over, and the two things roma can say
 * back about it.
 *
 * The event itself is untyped by default on purpose: what a Channel delivers is
 * that Channel's business, and this side of the wire only ever passes it along
 * to the Adapter that knows how to read it. What this file adds is the part no
 * Adapter can decide — when roma has finished with a Delivery, and whether it
 * finished with it successfully.
 */
export interface Delivery<Event = unknown> {
  /**
   * The Transport's own name for this delivery, the same on every redelivery of
   * it.
   *
   * Required rather than optional, because it is the only thing that tells a
   * redelivery apart from a second message that happens to say the same words.
   * A queue that delivers at least once will hand the same event over twice —
   * after a crash, after a lease expires, after a settlement is lost — and
   * roma has no other way to know it is looking at work it is already doing.
   */
  readonly id: string
  readonly event: Event
  /**
   * Finished with it. The Transport need not deliver it again.
   *
   * Named for the queue's own verb rather than for roma's, because it is the
   * queue's word — roma's is settling, and an Acknowledgement is something else
   * entirely, a message in a Conversation.
   *
   * Said only once roma has answered the Conversation, which is what makes a
   * crash mid-Task recoverable rather than silent: an event settled on arrival
   * is one that is gone the moment the process dies, and the person who sent it
   * is left waiting for an answer nothing is working on any more.
   */
  ack(): void | Promise<void>
  /**
   * Not finished with it, and roma is not going to be.
   *
   * For the failures another attempt could get past — the Channel being
   * unreachable, most of all. Not for an event roma cannot read: that one will
   * fail identically for ever, and giving it back makes it a message the
   * subscriber trips over on every pass.
   *
   * **What it buys is the Transport's, and may be nothing.** A Transport with
   * somewhere to hand a Delivery back to delivers it again; one without — a
   * socket roma holds open has no such place — says so by doing nothing, and the
   * work is lost. roma does not ask which, and nothing here branches on it: a
   * no-op and a declared inability produce identical behaviour, so the flag that
   * would tell them apart is one nothing would read (ADR-0028).
   */
  nack(): void | Promise<void>
}

/**
 * What roma does with one delivery.
 *
 * Resolves when the Delivery has been settled — finished with or handed back —
 * and never rejects. A Transport is entitled to treat a rejection as a bug
 * rather than as a signal, because there is nothing useful it could do with one:
 * whether a delivery is worth repeating is a judgement about the Channel and the
 * Core, both of which are on the other side of this function.
 */
export type Receiver<Event = unknown> = (delivery: Delivery<Event>) => Promise<void>

/**
 * The wire roma's ingress queue runs on, as much of it as roma uses.
 *
 * Two methods, and neither of them provisions anything. Whatever queue this is
 * exists before roma starts and outlives it — roma is a reader of it, and the
 * topic, the subscription and the credentials that reach them are configuration
 * rather than resources roma creates.
 *
 * Deliberately not a Channel concept, though today's only implementation lives
 * inside a Channel Adapter's directory. One Channel may deliver over a queue and
 * the next may need a receiver of its own inside its Adapter; what both owe the
 * Core is the same pair of promises — here are the events, and here is how to
 * stop.
 */
export interface Transport<Event = unknown> {
  /**
   * Start delivering events to `receiver`.
   *
   * Resolves once roma has subscribed — the point after which events are
   * roma's. Deliberately not "once the first event could arrive": whether a
   * queue has a stream open yet is its own business and not always observable,
   * and a promise that claimed otherwise would be one no implementation could
   * keep. What matters to the caller is the other end of it, that nothing was
   * subscribed before this was called.
   */
  receive(receiver: Receiver<Event>): Promise<void>
  /**
   * Stop delivering, and settle whatever is in flight.
   *
   * Resolves when nothing more will reach the receiver. It does not wait for
   * what is already in flight — a Task takes minutes and a host that sent a
   * signal will not wait that long — so a Delivery caught mid-flight is handed
   * back rather than finished with. `serve` is what makes that true from its
   * side; a Transport that also hands them back on close is doing the same
   * thing twice, which is harmless.
   */
  close(): Promise<void>
}
