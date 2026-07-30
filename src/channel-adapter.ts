import type { Command } from './commands.js'

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
   * Whoever sent it, named however the Channel names people.
   *
   * The Core does read it: it goes on the Audit Record, which is the only place
   * per-user attribution exists at all (ADR-0002), it is named above the message
   * Claude Code is given, and it comes back to the Adapter on every instruction
   * so a reply can be addressed. ADR-0009 is why it stopped being opaque —
   * everyone in a Chat thread shares one Session, so a Session that cannot tell
   * its Callers apart is one long message from nobody in particular.
   *
   * Still not *interpreted*: nothing in the Core parses it, compares it, or
   * decides anything by it. A Channel that names people by email and one that
   * names them by opaque id both work, because everything here does with it is
   * carry it and print it.
   */
  readonly caller: string
  /**
   * The same person as a human would read them, or null where the Channel had no
   * name to give.
   *
   * Beside `caller` rather than instead of it: the id is what a reply is
   * addressed with and what tells two people of the same name apart, and the
   * name is the half worth reading. Required rather than optional, so that a
   * Channel with no name for somebody says so instead of forgetting to.
   */
  readonly callerName: string | null
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
export interface TaskAddress {
  /**
   * Unique to one Task, and the same on every instruction that Task produces.
   *
   * A Command gets one too, though it is not a Task and produces exactly one
   * instruction. An Adapter that had to ask which kind of thing it was looking
   * at before it knew how to address the message it posts would be carrying a
   * distinction that belongs to the Core.
   */
  readonly taskId: string
  readonly conversationKey: string
  /**
   * Whose Task this is, exactly as the ingress message named them.
   *
   * Here because an Adapter cannot work it out for itself. The Task id is minted
   * in the Core, after `toIngress` has returned, so an Adapter holds no link
   * between the event it read and the instruction it is later handed; and the
   * Conversation Key is not that link either, since one Conversation can have
   * two Tasks in flight — and where a Channel lets several people share one, the
   * two belong to two different people.
   *
   * On every instruction rather than only the ones that end a Task, so that an
   * Adapter never has to ask what kind of thing it is looking at before it knows
   * who it is for. That is the same reason `taskId` is here.
   */
  readonly caller: string
  /** The readable half of the same person, or null. See `IngressMessage`. */
  readonly callerName: string | null
}

/**
 * One thing the Core asks a Channel to do.
 *
 * Deliberately short. It says what happened and who it is for, never how either
 * should look: an Adapter decides how a failure is rendered on its Channel and
 * how a person is addressed on it, and the Core never writes prose it cannot see
 * the result of.
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
        /**
         * What this Task cost, present only where it ran on metered billing.
         *
         * ADR-0002 requires the spend to be shown in the reply, and only for
         * Overflow: a Shared Window Task costs quota rather than money, and
         * pricing every reply would turn every answer into an invoice. Null
         * where the Turn was never priced — see the Audit Record for what that
         * means.
         */
        readonly overflowCostUsd?: number | null
      }
    | {
        /**
         * Say that the Shared Window is spent, when it comes back, and whether
         * Overflow can be taken.
         *
         * Its own message rather than an edit of the acknowledgement, because it
         * may carry an offer someone has to act on, and an acknowledgement is
         * mutating — the offer would be overwritten by the next update. The Task
         * is not over: it runs when the window returns, and this is what stops
         * the wait being silent.
         */
        readonly kind: 'blocked'
        /**
         * When the window comes back, in unix seconds.
         *
         * Off the stream's own `rate_limit_event` rather than estimated, which
         * is the only reason it is worth quoting to anybody.
         */
        readonly resetsAt: number
        /**
         * Whether the Adapter should offer Overflow at all.
         *
         * False where the provider says overage is unavailable, or where roma
         * has no metered credential. An Adapter that offered it anyway would
         * spend somebody's attention on a button that cannot work.
         */
        readonly overflowOffered: boolean
      }
    | {
        /**
         * Say that Overflow was asked for and refused by the monthly cap.
         *
         * Not a failure: the Task is still waiting for the window, and the
         * person can still stop it. The numbers are here so the refusal can be
         * stated rather than merely asserted.
         */
        readonly kind: 'overflow-refused'
        readonly capUsd: number
        readonly spentUsd: number
      }
    | {
        /** Say that a Task ended without a result, and why. Its own message too. */
        readonly kind: 'failure'
        readonly reason: string
      }
    | {
        /**
         * Say that a Task ended because someone stopped it.
         *
         * Its own outcome rather than a failure, because it is the one ending
         * that was asked for. Rendered as a failure it reads as roma breaking,
         * and it would carry the half-written answer the interrupt cut off as
         * its reason — the Turn's own text is all a failure has to explain
         * itself with, and an interrupted Turn's text is whatever it had got
         * through.
         *
         * Carries nothing. What was written before it stopped is already in the
         * acknowledgement, and there is no result: that is what stopping is.
         */
        readonly kind: 'stopped'
      }
    | {
        /**
         * Say what a Command did.
         *
         * A Command is not a Task — it drives no Turn, waits for nothing, and
         * has no result — so this is the whole of what one emits.
         */
        readonly kind: 'command-outcome'
        readonly command: Command
        /**
         * Whether it had anything to do.
         *
         * False only for `/stop` in a Conversation with no work in it. It is not
         * an error and an Adapter should not render it as one — the person asked
         * for something that had already happened — but it is not the same
         * message as "stopped" either: told a Task was stopped when none was
         * running, they stop watching one that is still going.
         */
        readonly carriedOut: boolean
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
  /**
   * Turn one of this Channel's events into the id of the Task whose offer of
   * Overflow is being taken, or null if it is not one.
   *
   * Optional, because a Channel with no way to present an offer needs no way to
   * read one being taken — and because the offer is the only thing in roma
   * anybody can answer with anything but a message.
   *
   * Its own reader rather than a third Command or a field on an ingress message.
   * A Command would be one anybody could type at any moment, including when
   * nothing is blocked, and ADR-0003 is explicit that there are two; a field on
   * the ingress message would make every Channel carry a concept for the sake of
   * one. What comes back here is a Task id roma minted and put on the offer, so
   * it can only ever answer an offer roma actually made.
   */
  toOverflowTaken?(event: Event): string | null
  /**
   * Carry out one instruction. Rejecting means it reached nobody.
   *
   * **A Task's last instruction is its last.** Four kinds end a Task — `result`,
   * `failure`, `stopped` and `command-outcome` — and no `progress` for that Task
   * follows one of them, however slow this Channel is about taking what it was
   * given. So an Adapter keeping an acknowledgement may drop it on one of those
   * four and does not have to defend against an update arriving afterwards.
   *
   * A guarantee rather than an obligation, and the Core is what keeps it:
   * `ProgressReporter.stop` drops whatever was still queued. Left to the
   * Adapters it would be a rule every Channel had to be told, and the first one
   * was written without knowing it — a late update finds no acknowledgement to
   * edit and posts a second message, underneath the answer.
   *
   * `blocked` and `overflow-refused` are **not** endings: they are messages
   * about a Task that is still going, and updates follow them.
   */
  deliver(instruction: OutboundInstruction): void | Promise<void>
}
