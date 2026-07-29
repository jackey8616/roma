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
 * What a Task is doing right now, as much of it as the stream will say.
 *
 * Facts rather than prose, the same as every instruction: whether a phase is
 * worth showing at all, and in what words, belongs to the Adapter.
 */
export type TaskProgress =
  | {
      /**
       * Waiting its turn, with how much is ahead of it.
       *
       * How much is ahead, not when it will run. A Task waiting on its own
       * Conversation is stepped over by one that is free to run, so this is not
       * a promise about order and an Adapter should not render it as one.
       */
      readonly phase: 'queued'
      /**
       * How many Tasks were waiting, this one included — so 1 means it is the
       * only one.
       */
      readonly position: number
    }
  | {
      /**
       * Running, with nothing more specific to say.
       *
       * Both the moment a Task starts and the moment a tool finishes and
       * nothing has replaced it yet.
       */
      readonly phase: 'working'
    }
  | {
      /**
       * Thinking, with Claude Code's running estimate of how much.
       *
       * Never what about. `thinking_delta` carries `"thinking": ""` and a token
       * count, so the content is not in the stream to be shown.
       */
      readonly phase: 'thinking'
      readonly estimatedTokens: number
    }
  | {
      /**
       * A tool is running, and the stream will say nothing at all until it
       * finishes — 25 seconds, in the capture this was designed against.
       */
      readonly phase: 'tool'
      /**
       * What is running: the tool's name, or Claude Code's own description of
       * the running task once the stream carries one, which is the command
       * itself.
       */
      readonly tool: string
    }
  | {
      /** Writing the answer, with everything written so far. */
      readonly phase: 'writing'
      readonly text: string
    }

/**
 * Which Task an outbound instruction is about.
 *
 * The Conversation says where it goes; the Task id says which piece of work it
 * belongs to, and an Adapter needs both. One Conversation can have two Tasks in
 * flight — one running and one waiting behind it — each with an acknowledgement
 * of its own to keep up to date, so the Conversation alone does not identify a
 * message to edit.
 */
interface TaskAddress {
  /** Unique to one Task, and the same on every instruction that Task produces. */
  readonly taskId: string
  readonly conversationKey: string
}

/**
 * One thing the Core asks a Channel to do.
 *
 * Deliberately short. It says what happened, not how it should look: an Adapter
 * decides how a failure is rendered on its Channel, and the Core never writes
 * prose it cannot see the result of.
 */
export type OutboundInstruction = TaskAddress &
  (
    | {
        /**
         * Say what a Task is doing, in the same message every time.
         *
         * The first one is the acknowledgement — post it. Every one after it is
         * an edit of that message rather than a new one, which is why they
         * carry the Task id. Where the Channel cannot edit, only the first
         * arrives, so an Adapter never has to decide whether to post again.
         */
        readonly kind: 'progress'
        readonly progress: TaskProgress
      }
    | {
        /**
         * Post the result of a Task as a new message in the Conversation.
         *
         * Always its own message, on every Channel, never the acknowledgement
         * edited one last time. It is what people search for, quote, and reply
         * to months later, and burying it inside a progress message that was
         * mutating for the last five minutes makes it hard to find. Nothing in
         * the Core makes this conditional.
         */
        readonly kind: 'result'
        readonly text: string
      }
    | {
        /** Say that a Task ended without a result, and why. Its own message too. */
        readonly kind: 'failure'
        readonly reason: string
      }
  )

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
   * place as the Task runs — only where this is true. Where it is false the
   * Core sends the acknowledgement and nothing after it: ADR-0003 allows either
   * periodic new messages or suppression, and an update every 5–10 seconds of a
   * five-minute Task is thirty to sixty messages burying the Conversation it is
   * reporting into. The separate final result is unaffected either way.
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
