/**
 * One message from one person, on its way into the Core.
 *
 * The Channel it came from is gone by this point: whatever the Adapter knew
 * about spaces, rooms, threads, or users has been reduced to a key, an identity,
 * and some text. That reduction is the whole of the inbound contract.
 */
export interface IngressMessage {
  /**
   * The stable string naming the Conversation this message belongs to. The
   * Session id derives from it, which is why roma needs no database.
   */
  readonly conversationKey: string
  /**
   * Whoever sent it, named however the Channel names people. Opaque to the
   * Core, which never interprets it — it exists so the audit record can say who
   * asked, since the provider offers no attribution of its own.
   */
  readonly caller: string
  readonly text: string
}

/**
 * One thing the Core asks a Channel to do.
 *
 * Deliberately short. It says what happened, not how it should look: an Adapter
 * decides how a failure is rendered on its Channel, and the Core never writes
 * prose it cannot see the result of.
 */
export type OutboundInstruction =
  | {
      /**
       * Post the result of a Task as a new message in the Conversation.
       *
       * Always its own message, on every Channel. It is what people search for,
       * quote, and reply to months later, and burying it inside a progress
       * message that was mutating for the last five minutes makes it hard to
       * find. Nothing in the Core makes this conditional.
       */
      readonly kind: 'result'
      readonly conversationKey: string
      readonly text: string
    }
  | {
      /** Say that a Task ended without a result, and why. */
      readonly kind: 'failure'
      readonly conversationKey: string
      readonly reason: string
    }
  | {
      /**
       * Say that a Task is waiting its turn, and how much is ahead of it.
       *
       * Sent once, when the Task joins the queue, and only to a Task that has
       * to wait at all. Waiting in silence is what makes people send the
       * message again, and every resend lengthens the queue that caused it.
       */
      readonly kind: 'queued'
      readonly conversationKey: string
      /** How many Tasks were waiting, this one included. 1 means it is next. */
      readonly position: number
    }

/**
 * The two things about a Channel that the Core bends around.
 *
 * Declared rather than detected: a Channel knows what it can do, and the Core
 * has no way to find out by trying.
 */
export interface ChannelCapabilities {
  /**
   * Whether a message this Channel has posted can be edited afterwards.
   *
   * Progress reporting runs in its full form — one acknowledgement, mutated in
   * place as the Task runs — only where this is true. Where it is false,
   * progress degrades to periodic messages or to nothing; the separate final
   * result is unaffected either way.
   */
  readonly messageMutation: boolean
  /**
   * Whether this Channel supplies a Conversation Key that stays the same for
   * the life of a Conversation.
   *
   * A Channel that cannot mints and persists one inside its own Adapter. The
   * Core derives Session ids and stores nothing, so it has no way to make an
   * unstable key stable, and a Conversation whose key moves is a Conversation
   * that loses its context every time it does.
   */
  readonly stableConversationKey: boolean
}

/**
 * The interface every Channel implements: two translations and two declarations.
 *
 * **Provisional.** It was designed against one Channel and cannot be validated
 * until a second exists, so it is deliberately the smallest thing that serves
 * the Channel roma actually has. Expect the second Channel to change it, and
 * prefer changing it then to guessing now — Channel-abstraction machinery that
 * nothing exercises is how an interface ends up wrong in a way nobody can see.
 *
 * Only the outbound half faces the Core. Inbound translation happens before the
 * Core is involved at all, and `Event` — whatever this Channel delivers — is a
 * type the Core never names.
 */
export interface ChannelAdapter<Event = unknown> {
  readonly capabilities: ChannelCapabilities
  /**
   * Turn one of this Channel's events into a message for the Core, or null if
   * it is not one roma should answer.
   */
  toIngress(event: Event): IngressMessage | null
  /** Carry out one instruction. Rejecting means it reached nobody. */
  deliver(instruction: OutboundInstruction): void | Promise<void>
}
