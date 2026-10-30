import type { Command } from './commands.js'

/**
 * An Enclosure before anybody has fetched it: the one member of the inbound
 * contract that is not yet a value.
 *
 * `redeem` is called once, by the Core, after the Session is known and
 * immediately before the bytes are written to disk.
 * Enforced by `fence:core-enclosures-redeemed-late`.
 */
export interface PendingEnclosure {
  /**
   * What the Channel says the sender called it. Printed, never interpreted.
   * Enforced by `fence:core-enclosure-path-is-minted`.
   */
  readonly name: string
  /**
   * Who sent this along where that is somebody other than the Caller, as a
   * Quotation's author is named; null where the Caller attached it themselves.
   * Enforced by `fence:adapter-ingress-says-everything`.
   */
  readonly from: string | null
  /**
   * Obtain the bytes.
   *
   * Called at most once per Task, and allowed to reject: a Channel that cannot
   * reach what it was told about says so here, and the Task ends as a failure
   * with the reason. That is the whole failure path, and for some Channels
   * (Chat's `driveDataRef`) it is the normal one.
   */
  redeem(): Promise<Uint8Array>
}

/**
 * A Quotation, as the Channel snapshotted it. Never a handle to be followed.
 *
 * Untrusted: it is the one string roma escapes before writing it down. See
 * `attributed`.
 */
export interface Quotation {
  readonly text: string
  /**
   * Whoever the Channel says wrote it, or null where it said nothing. Printed
   * as a Caller is printed; nothing parses or compares it, so its shape may be
   * an id or a display name. Never a stand-in where the Channel named nobody.
   */
  readonly author: string | null
}

/** An Ingress Message, on its way into the Core. */
export interface IngressMessage {
  /** The Session id derives from it. */
  readonly conversationKey: string
  /**
   * The Channel's stable name for the Caller. Carried and printed, never
   * parsed, compared or decided by.
   */
  readonly caller: string
  /**
   * The Caller's readable name, or null where the Channel had none.
   * Enforced by `fence:adapter-ingress-says-everything`.
   */
  readonly callerName: string | null
  readonly text: string
  /**
   * In the order the Channel gave them; empty where there are none.
   * Enforced by `fence:adapter-ingress-says-everything`.
   */
  readonly enclosures: readonly PendingEnclosure[]
  /**
   * Null where the message quotes none. Kept beside the text, never folded
   * into it. Enforced by `fence:core-command-ignores-the-quotation`.
   * Required and nullable. Enforced by `fence:adapter-ingress-says-everything`.
   */
  readonly quotation: Quotation | null
}

/**
 * What a Task is doing right now, as much of it as the stream will say. Facts,
 * not prose: whether and how to show a phase belongs to the Adapter.
 */
export type TaskProgress =
  | {
      /**
       * Waiting its turn. Not a promise about order: a Task waiting on its own
       * Conversation is stepped over by one free to run, so an Adapter should
       * not render this as one.
       */
      readonly phase: 'queued'
      /** How many Tasks were waiting, this one included; 1 means it is the only one. */
      readonly position: number
    }
  | {
      /**
       * Running, with nothing more specific to say: at the start, and after a
       * tool finishes until something replaces it.
       */
      readonly phase: 'working'
    }
  | {
      /**
       * A Compaction is under way, auto or asked for with `/compact`, and the
       * stream says nothing else until it finishes. Carries nothing: its
       * figures arrive only when it is over.
       */
      readonly phase: 'compacting'
    }
  | {
      /**
       * Thinking, with Claude Code's running token estimate. Never what about:
       * the content is not in the stream.
       */
      readonly phase: 'thinking'
      readonly estimatedTokens: number
    }
  | {
      /** A tool is running, and the stream says nothing at all until it finishes. */
      readonly phase: 'tool'
      /**
       * The tool's name, or Claude Code's own description of the running task
       * once the stream carries one, which is the command itself.
       */
      readonly tool: string
    }
  | {
      /**
       * Writing the answer: how much of it exists so far, never what.
       * Enforced by `fence:core-writing-progress-moves`.
       */
      readonly phase: 'writing'
      readonly characters: number
    }

/**
 * Which Task an Outbound Instruction is about. One Conversation can have two
 * Tasks in flight, each with its own Acknowledgement, so an Adapter needs both
 * halves to find a message to edit.
 */
export interface TaskAddress {
  /**
   * Unique to one Task, and the same on every instruction it produces. A
   * Command gets one too, though it produces exactly one instruction.
   */
  readonly taskId: string
  readonly conversationKey: string
  /** Whose Task this is, exactly as the Ingress Message named them. On every instruction. */
  readonly caller: string
  /** The readable half of the same person, or null. See `IngressMessage`. */
  readonly callerName: string | null
}

/**
 * One thing the Core asks a Channel to do: what happened and whose it is,
 * never how it should look.
 */
export type OutboundInstruction = TaskAddress &
  (
    | {
        /**
         * Say what a Task is doing, in the same message every time.
         *
         * The first one is the Acknowledgement: post it. Every one after it
         * edits that message. Where the Channel cannot edit, only the first
         * arrives, so an Adapter never decides whether to post again.
         */
        readonly kind: 'progress'
        readonly progress: TaskProgress
      }
    | {
        /** Post the result as a new message, on every Channel: never an edit of the Acknowledgement. */
        readonly kind: 'result'
        readonly text: string
        /**
         * What this Task cost, present only where it ran on Overflow. Null
         * where the Turn was never priced; see the Audit Record.
         */
        readonly overflowCostUsd?: number | null
      }
    | {
        /**
         * Say that the Shared Window is spent, when it comes back, and whether
         * Overflow can be taken. Its own message, never an edit of the
         * Acknowledgement, since the offer must survive the next update.
         *
         * Not an ending: the Task runs when the window returns.
         */
        readonly kind: 'blocked'
        /** When the window comes back, in unix seconds, off the stream's `rate_limit_event`. */
        readonly resetsAt: number
        /**
         * Whether to offer Overflow at all. False where the provider says
         * overage is unavailable or roma has no metered credential.
         */
        readonly overflowOffered: boolean
      }
    | {
        /**
         * Say that Overflow was asked for and refused by the monthly cap. Not a
         * failure: the Task still waits for the window and can still be stopped.
         */
        readonly kind: 'overflow-refused'
        readonly capUsd: number
        readonly spentUsd: number
      }
    | {
        /**
         * Say that this Conversation's Session cannot be reduced any further,
         * so it will serve no more Turns, and that `/clear` is the way out.
         *
         * **Not an ending.** It arrives mid-Task, the way `blocked` does, and
         * the Task goes on to whatever ending it has, usually a failure. Post
         * it as its own message and keep the Acknowledgement. Carries nothing.
         */
        readonly kind: 'context-full'
      }
    | {
        /** Say that a Task ended without a result, and why. Its own message too. */
        readonly kind: 'failure'
        readonly reason: string
      }
    | {
        /**
         * Say that a Task ended because someone stopped it. Its own outcome, not
         * a failure. Carries nothing: what was written is already in the
         * Acknowledgement, and there is no result.
         */
        readonly kind: 'stopped'
      }
    | {
        /** Say what a Command did. The whole of what one emits. */
        readonly kind: 'command-outcome'
        /**
         * Never `/model`, which answers as a `result` or `failure` the way a
         * Relay's output does.
         */
        readonly command: Exclude<Command, 'model'>
        /**
         * Whether it had anything to do. False only for `/stop` in a
         * Conversation with no work in it: not an error, and not the same
         * message as `stopped` either.
         */
        readonly carriedOut: boolean
      }
    | {
        /**
         * Say what a Conversation may choose, and offer the choices: `/model`,
         * `/effort` or `/caveman` asked what is on offer, or naming something
         * that is not. A name on the Menu, or `default`, is a `result`.
         *
         * **The text is the whole answer already.** A Channel that cannot
         * render a choice posts the text and is correct, not degraded.
         */
        readonly kind: 'choice'
        /** The answer in words, Menu included. Posted as a `result`'s text is. */
        readonly text: string
        /**
         * Which Command a choice would be made with. Taking a choice is sending
         * this Command with one of `options`, as the Caller would have typed it:
         * `/model opus`.
         */
        readonly chooses: Extract<Command, 'model' | 'effort' | 'caveman'>
        /** Every name that may be chosen, in Menu order. Never empty. */
        readonly options: readonly string[]
        /**
         * The name asked for and not offered, or null where nothing was
         * refused. The only thing that tells *what is on offer* from *that is
         * not on offer*.
         */
        readonly refused: string | null
      }
  )

/** The two things about a Channel that the Core bends around. Declared, not detected. */
export interface ChannelCapabilities {
  /**
   * Whether a posted message can be edited. Where false, the Core sends the
   * Acknowledgement and no progress after it; the result is unaffected.
   */
  readonly messageMutation: boolean
  /**
   * Whether this Channel supplies a Conversation Key stable for the life of a
   * Conversation. A Channel that cannot must mint and persist one in its own
   * Adapter: the Core stores nothing and cannot stabilise it.
   */
  readonly stableConversationKey: boolean
}

/**
 * The interface every Channel implements: two translations and two
 * declarations. Only the outbound half faces the Core; `Event` is a type the
 * Core never names.
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
   * Overflow is being taken, or null if it is not one. Optional: a Channel that
   * cannot present an offer needs no way to read one. The id is one roma minted
   * onto the offer, so this can only answer an offer roma made.
   */
  toOverflowTaken?(event: Event): string | null
  /**
   * Carry out one instruction. Rejecting means it reached nobody.
   *
   * **A Task's last instruction is its last.** Four kinds end a Task —
   * `result`, `failure`, `stopped` and `command-outcome` — and no `progress`
   * for that Task follows one, however slow this Channel is. An Adapter may
   * drop its Acknowledgement on one of those four.
   * Enforced by `fence:core-no-update-after-the-answer`.
   *
   * `blocked`, `overflow-refused` and `context-full` are **not** endings:
   * updates follow them.
   */
  deliver(instruction: OutboundInstruction): void | Promise<void>
}
