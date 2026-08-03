import type { Command } from './commands.js'

/**
 * Something sent along with a message, before anybody has fetched it.
 *
 * The one member of the inbound contract that is not yet a value. An Enclosure
 * can be tens of megabytes and is sized by whoever sent it, so fetching it when
 * the message is *read* would buffer it across queueing, across Parking — which
 * CONTEXT.md defines as holding no process — and across a `/stop` that means
 * nobody ever wanted it. `redeem` is therefore called once, by the Core, after
 * the Session is known and immediately before the bytes are written to disk
 * (ADR-0011).
 *
 * A named type rather than a bare `() => Promise<…>` on `IngressMessage`, so
 * that a reader can see that something here has not happened yet: everything
 * else on that interface is a value, and a function hidden among strings reads
 * as one until it throws.
 */
export interface PendingEnclosure {
  /**
   * What the Channel says the sender called it.
   *
   * Printed and never interpreted — it is put in front of the agent so a log
   * can be told from a screenshot, and it is **never** made into a path.
   * `contentName` is chosen by whoever sent the message, so using it to address
   * a file means defending traversal, collision and whatever a filesystem does
   * with 200 characters of Unicode, all at once. roma mints the path instead
   * (ADR-0011), which leaves this a string like any other the Channel supplies:
   * untrusted, and harmless because nothing decides anything by it.
   */
  readonly name: string
  /**
   * Who sent this along, where that is somebody other than the Caller, and null
   * where the Caller attached it themselves.
   *
   * The Caller's own is the ordinary case and says nothing here: the Caller
   * Marker above the message already names them, and repeating it on every
   * Enclosure would be roma answering a question nobody asked. What this
   * answers is the question a Quotation makes askable — a forwarded message
   * brings its own attachments, and an Enclosure that arrived that way sits in
   * the same list as one the Caller picked out of their own file browser
   * (ADR-0021).
   *
   * Named the same way a Quotation's author is, because it is the same person
   * and a reader comparing the two tags should not have to work that out.
   * Required rather than optional, so that a Channel with somebody to name says
   * so rather than forgetting to — the argument `callerName` and `enclosures`
   * both make below.
   */
  readonly from: string | null
  /**
   * Obtain the bytes.
   *
   * Called at most once per Task, and allowed to reject: a Channel that cannot
   * reach what it was told about — Chat's `driveDataRef` points into the
   * *sender's* Drive, which roma has no scope for — says so here, and the Task
   * ends as a failure with the reason. That is the whole of the failure path,
   * and for a Channel where a whole class of attachment is unreachable it is
   * the normal one rather than an edge case.
   */
  redeem(): Promise<Uint8Array>
}

/**
 * Somebody else's words, carried into a message rather than typed into it.
 *
 * The other half of what a person can put in front of the agent without writing
 * it: an Enclosure is bytes, and this is a passage somebody else wrote and the
 * Caller pointed at. A Channel that lets one message quote another produces
 * these — Chat's quoted reply and its forward are both one — and what roma takes
 * is the **snapshot**: the words as they stood when they were quoted, and who
 * the Channel says wrote them. Never a handle to be followed. Chat hands over a
 * link as well and roma does not take it, which is what keeps this free, keeps
 * roma's credentials where they are, and keeps a quotation of an edited message
 * saying what was actually quoted (ADR-0021).
 *
 * Untrusted in a way nothing before it was. Everything else the model reads as
 * content was typed by the person who sent it, so it arrives last with nothing
 * of roma's after it; a Quotation is content roma **frames**, and it is
 * therefore the one string roma escapes before writing it down. See
 * `attributed`.
 */
export interface Quotation {
  /** The passage itself, exactly as the Channel snapshotted it. */
  readonly text: string
  /**
   * Whoever the Channel says wrote it, or null where it said nothing.
   *
   * Read as a Caller is read and printed as a Caller is printed: nothing parses
   * it, compares it, or decides anything by it. Chat's is a bare string of
   * undocumented shape — an id in one reading and a display name in the other —
   * and roma is correct either way precisely because it only ever prints it.
   *
   * Null rather than a stand-in, because a Quotation whose author roma invented
   * is worse than one with no author named: the whole reason to carry this is
   * that unattributed words in front of the model are read as the Caller's own.
   */
  readonly author: string | null
}

/**
 * One message from one person, on its way into the Core.
 *
 * The Channel it came from is gone by this point: whatever the Adapter knew
 * about spaces, rooms, threads, or users has been reduced to a key, an identity,
 * some text, and whatever was sent alongside it. That reduction is the whole of
 * the inbound contract.
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
  /**
   * What was sent alongside the text, in the order the Channel gave them.
   *
   * Required rather than optional, and empty where there are none — the same
   * argument `callerName` makes: a Channel that has something to hand over and
   * forgets to is indistinguishable from one that had nothing, and the failure
   * is silent. Silence is the fault this whole area exists to fix, so the type
   * makes every Channel answer the question.
   */
  readonly enclosures: readonly PendingEnclosure[]
  /**
   * The passage this message quotes, or null where it quotes none.
   *
   * Beside the text rather than folded into it, and that is the whole of why the
   * Core learns a word for this at all. An Adapter that spliced a quotation into
   * `text` would be composing what the model reads — which is the Core's, and
   * only the Core's, because `readCommand` matches the **whole** message:
   * quoting something and typing `/stop` would quietly stop meaning `/stop`, on
   * the one Channel that had done it (ADR-0021).
   *
   * Required and nullable for the reason `callerName` is: a Channel that had one
   * and forgot to hand it over is indistinguishable from a Channel whose
   * messages never quote anything.
   */
  readonly quotation: Quotation | null
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
       * A Compaction is under way, and the stream will say nothing else until it
       * finishes — 28,517ms, in the longest capture roma holds.
       *
       * The `tool` phase's problem with a different cause, and it arrives two
       * ways: inside somebody's ordinary Turn, where auto-compaction crossed the
       * threshold, and as the whole of a `/compact` somebody asked for. An
       * Adapter has no reason to tell those apart — what a person watching needs
       * is that the silence is work rather than a hang.
       *
       * Carries nothing. `compact_metadata`'s figures arrive with the *boundary*,
       * which is the moment it is over, so there is no progress to report while
       * it runs — and an Acknowledgement saying how much has been discarded so
       * far would be saying what the reply is about to say.
       */
      readonly phase: 'compacting'
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
      /**
       * Writing the answer, with how much of it exists so far.
       *
       * How much, never what. The prose is in the stream — `--include-partial-messages`
       * puts it there — and an Acknowledgement that showed it would be saying
       * what the Result is about to say, in the same Conversation, seconds
       * apart. ADR-0010 is where that was decided and what it cost.
       *
       * A number rather than nothing, and that is load-bearing: this is what
       * tells a Reporter that one moment of writing differs from the last, and
       * a phase carrying no number at all would compare equal to itself every
       * time and leave the Acknowledgement frozen for the whole of a
       * generating Turn — which is what a dead Task looks like.
       */
      readonly phase: 'writing'
      readonly characters: number
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
        /**
         * Say that this Conversation's Session cannot be reduced any further, so
         * it will serve no more Turns, and that `/clear` is the way out.
         *
         * The one place roma knows an exit the person cannot guess. Claude Code
         * tried to compact the context and reported that it could not be brought
         * below the limit; every message after this fails, roma's repair is a new
         * Session Generation, and nothing else would ever tell them to ask for
         * one. Staying silent wastes the only useful thing roma knows here.
         *
         * **Not an ending.** It arrives mid-Task, the way `blocked` does, and the
         * Task goes on to whatever ending it has — usually a failure, since a
         * Session that cannot be reduced is one that cannot answer. An Adapter
         * posts it as its own message and keeps the acknowledgement it was
         * mutating.
         *
         * Carries nothing, like `stopped`. There is one fact and one remedy, and
         * neither the code Claude Code named nor how full the context got is
         * something the person can act on — those go to the operator.
         *
         * Nothing is said about a Compaction that *worked*: the context is
         * already gone by the time roma could speak, there is nothing to do with
         * the news, and ADR-0010 sets a high bar for another message in a
         * Conversation. It goes on the Audit Record instead, where the money is.
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
        /**
         * Which Command, and never `/model`.
         *
         * The two whose whole outcome is "there was something to do, or there
         * was not". `/model` has an answer rather than an outcome — which model,
         * which ones are on offer, why a name was refused — so it comes back as
         * a `result` or a `failure`, the way a Relay's output does, and an
         * Adapter needs to learn nothing new to post it.
         */
        readonly command: Exclude<Command, 'model'>
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
   * `blocked`, `overflow-refused` and `context-full` are **not** endings: they
   * are messages about a Task that is still going, and updates follow them.
   */
  deliver(instruction: OutboundInstruction): void | Promise<void>
}
