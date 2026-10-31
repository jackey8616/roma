import type {
  ChannelAdapter,
  ChannelCapabilities,
  IngressMessage,
  OutboundInstruction,
} from '../../channel-adapter.js'
import type { Command } from '../../commands.js'
import { writeToStderr, type OperatorLog } from '../../operator-log.js'
import { DiscordRefusal, MAX_BUTTONS, type DiscordApi, type DiscordButton } from './discord-api.js'
import {
  asString,
  chooseId,
  overflowId,
  readChosenOption,
  readIngressMessage,
  readOverflowTaken,
  type DiscordEvent,
} from './discord-events.js'
import { OVERFLOW_BUTTON, outcomeMessages, progressText, threadName } from './render.js'

/**
 * How many times roma makes one Discord call before it gives up on it.
 *
 * Enforced by `fence:discord-attempts-bounded`.
 */
export const ATTEMPTS = 3

/**
 * How long roma waits before a retry Discord gave it no time for, and the
 * longest wait it will sit through at all.
 *
 * The floor is doubled per attempt, and used only where the response carried no
 * `Retry-After` (a 503, or a socket that never answered); where Discord said how
 * long, that is what roma waits. Past the ceiling, roma gives up and says so.
 *
 * Enforced by `fence:discord-no-sleeping-through-a-ban`.
 */
export const RETRY_FLOOR_MS = 500
export const RETRY_CEILING_MS = 30_000

/**
 * How many Conversations roma keeps the answering address of.
 *
 * Enforced by `fence:discord-answering-is-bounded`.
 */
export const REMEMBERED = 1_000

/** Enforced by `fence:discord-acknowledgement-kept-until-the-end`. */
const ENDS_THE_TASK = new Set(['result', 'failure', 'stopped', 'command-outcome', 'choice'])

interface Answering {
  readonly channel: string
  readonly replyTo: string | null
}

interface Answered {
  readonly channel: string
  readonly message: string
  readonly name: string
  /** Enforced by `fence:discord-thread-asked-for-once`. */
  place: Promise<string> | null
}

/** The one thing this Adapter does that no Conversation will ever hear about. */
export type DiscordAdapterLogRecord = {
  /**
   * roma was refused the thread a Conversation Key names, so it is answering in
   * the parent channel, and every message in that channel is getting a Session
   * of its own. `status` is Discord's own number, as it came.
   */
  readonly event: 'thread-unopened'
  /** Where roma is answering instead, and where a missing permission would be. */
  readonly channel: string
  readonly status: number
}

export interface DiscordAdapterOptions {
  /** How roma reaches Discord over HTTP, in both directions: posting, and redeeming attachments. */
  readonly api: DiscordApi
  /**
   * Where to say that a Conversation is being answered somewhere other than
   * where its key names. Defaults to stderr rather than to silence, unlike Chat's.
   *
   * Enforced by `fence:discord-adapter-log-defaults-to-stderr`.
   */
  readonly log?: OperatorLog<DiscordAdapterLogRecord>
  /**
   * How roma waits between attempts at a call Discord refused.
   *
   * Injectable only so that a test can pin the moment rather than spend it;
   * nothing else should pass it.
   */
  readonly wait?: (ms: number) => Promise<void>
}

/**
 * Discord, and one of the two modules in roma that knows Discord exists; the
 * other is `GatewayTransport`, which decides the two things a synchronous reader
 * cannot: whether a channel is one of the guild's, and what a Quotation says.
 *
 * It keeps no identity. What it keeps is where to answer each Conversation (the
 * message and its parent channel), bounded by `REMEMBERED`; losing that costs no
 * Conversation its Session.
 */
export class DiscordAdapter implements ChannelAdapter<DiscordEvent> {
  readonly capabilities: ChannelCapabilities = {
    messageMutation: true,
    stableConversationKey: true,
  }

  readonly #api: DiscordApi
  readonly #log: OperatorLog<DiscordAdapterLogRecord>
  readonly #wait: (ms: number) => Promise<void>

  /** Enforced by `fence:discord-answering-by-caller`. Enforced by `fence:discord-answering-is-bounded`. */
  readonly #answering = new Map<string, Answered>()

  /** Enforced by `fence:discord-acknowledgement-is-a-promise`. */
  readonly #acknowledgements = new Map<string, Promise<string>>()

  constructor({ api, log, wait }: DiscordAdapterOptions) {
    this.#api = api
    this.#log = log ?? writeToStderr
    this.#wait = wait ?? sleep
  }

  /** One Discord event as a message for the Core, or null if roma should not answer it. */
  toIngress(event: DiscordEvent): IngressMessage | null {
    const message =
      readChosenOption(event) ??
      readIngressMessage(event, {
        download: (url) => this.#api.download(url),
      })
    if (message !== null) this.#remember(event, message)
    return message
  }

  /**
   * A press on the Overflow button, as the Task it was about. Answers null for
   * every press `toIngress` answered, whichever is asked first: one reader reads
   * every `custom_id` and answers one kind (`Pressed`).
   */
  toOverflowTaken(event: DiscordEvent): string | null {
    return readOverflowTaken(event)
  }

  /**
   * Carry out one instruction, as one or more Discord messages. Progress edits the
   * acknowledgement in place; everything else is a new message. Every post is
   * retried, up to `ATTEMPTS`.
   *
   * Rejects where the Conversation was not told.
   *
   * Enforced by `fence:discord-refusal-not-swallowed`.
   */
  async deliver(instruction: OutboundInstruction): Promise<void> {
    const { taskId, conversationKey } = instruction
    const answering = await this.#answeringFor(instruction)

    if (instruction.kind === 'progress') {
      await this.#acknowledge(taskId, answering, progressText(instruction.progress))
      return
    }

    // Enforced by `fence:discord-acknowledgement-kept-until-the-end`.
    if (ENDS_THE_TASK.has(instruction.kind)) this.#acknowledgements.delete(taskId)

    const buttons =
      instruction.kind === 'blocked' && instruction.overflowOffered
        ? [offerButton(taskId)]
        : instruction.kind === 'choice'
          ? choiceButtons(instruction.chooses, conversationKey, instruction.options)
          : []

    const messages = outcomeMessages(instruction)
    for (const [at, text] of messages.entries()) {
      // Enforced by `fence:discord-reply-on-first-piece-only`.
      const replyTo = at === 0 ? answering.replyTo : null
      // Enforced by `fence:discord-buttons-on-last-piece-only`.
      const last = at === messages.length - 1
      await this.#retrying(() =>
        this.#api.post({
          channel: answering.channel,
          text,
          replyTo,
          buttons: last ? buttons : [],
        }),
      )
    }
  }

  async #answeringFor({ conversationKey, caller }: OutboundInstruction): Promise<Answering> {
    const answered = this.#answering.get(addressOf(conversationKey, caller))
    return {
      channel: await this.#place(conversationKey, answered),
      replyTo: answered?.message ?? null,
    }
  }

  /** Enforced by `fence:discord-press-survives-thread-fallback`. */
  #remember(event: DiscordEvent, message: IngressMessage): void {
    const channel = asString(event.message['channel_id'])
    const id = asString(event.message['id'])
    if (channel === null || id === null) return

    const at = addressOf(message.conversationKey, message.caller)
    // Enforced by `fence:discord-answering-evicts-the-least-recent`.
    this.#answering.delete(at)
    if (this.#answering.size >= REMEMBERED) {
      const oldest = this.#answering.keys().next().value
      if (oldest !== undefined) this.#answering.delete(oldest)
    }
    this.#answering.set(at, { channel, message: id, name: threadName(message.text), place: null })
  }

  #place(conversationKey: string, answered: Answered | undefined): Promise<string> {
    if (answered === undefined || answered.channel === conversationKey) {
      return Promise.resolve(conversationKey)
    }
    if (answered.place !== null) return answered.place

    const opening = this.#openThread(conversationKey, answered)
    answered.place = opening
    return opening.catch((error: unknown) => {
      // Enforced by `fence:discord-failed-thread-forgotten`.
      if (answered.place === opening) answered.place = null
      throw error
    })
  }

  /** Enforced by `fence:discord-thread-refusal-falls-back`. */
  async #openThread(conversationKey: string, answered: Answered): Promise<string> {
    try {
      return await this.#retrying(() =>
        this.#api.startThread(answered.channel, conversationKey, answered.name),
      )
    } catch (error) {
      if (!refused(error)) throw error
      this.#log({ event: 'thread-unopened', channel: answered.channel, status: error.status })
      return answered.channel
    }
  }

  async #acknowledge(taskId: string, { channel, replyTo }: Answering, text: string): Promise<void> {
    const posted = this.#acknowledgements.get(taskId)
    if (posted !== undefined) {
      const id = await posted
      await this.#retrying(() => this.#api.edit(channel, id, text))
      return
    }

    // Replied to like the answer is, and for the same reason: a thread can carry
    // two of these at once — one running, one queued behind it — and the person
    // waiting is who most needs to know which is theirs. Discord notifies on the
    // post and not on the edits, so this is one notification per Task rather
    // than one per update.
    const posting = this.#retrying(() => this.#api.post({ channel, text, replyTo, buttons: [] }))
    this.#acknowledgements.set(taskId, posting)
    try {
      await posting
    } catch (error) {
      // Enforced by `fence:discord-failed-acknowledgement-forgotten`.
      if (this.#acknowledgements.get(taskId) === posting) this.#acknowledgements.delete(taskId)
      throw error
    }
  }

  async #retrying<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call()
      } catch (error) {
        const wait = attempt < ATTEMPTS ? waitBefore(error, attempt) : null
        if (wait === null) throw error
        await this.#wait(wait)
      }
    }
  }
}

/** Enforced by `fence:discord-answering-by-caller`. */
function addressOf(conversationKey: string, caller: string): string {
  return `${conversationKey} ${caller}`
}

/** Enforced by `fence:discord-overflow-named-by-task`. */
function offerButton(taskId: string): DiscordButton {
  return { label: OVERFLOW_BUTTON, customId: overflowId(taskId) }
}

/** Enforced by `fence:discord-menu-whole-or-not-at-all`. */
function choiceButtons(
  chooses: Extract<Command, 'model' | 'effort' | 'caveman'>,
  conversationKey: string,
  options: readonly string[],
): readonly DiscordButton[] {
  if (options.length > MAX_BUTTONS) return []
  return options.map((option) => ({
    label: option,
    customId: chooseId(chooses, conversationKey, option),
  }))
}

function refused(error: unknown): error is DiscordRefusal {
  return error instanceof DiscordRefusal && error.status !== 429 && error.status < 500
}

/** Enforced by `fence:discord-retry-only-what-can-work`. */
function waitBefore(error: unknown, attempt: number): number | null {
  if (refused(error)) return null
  const asked = error instanceof DiscordRefusal ? error.retryAfterMs : null
  if (asked === null) return Math.min(RETRY_FLOOR_MS * 2 ** (attempt - 1), RETRY_CEILING_MS)
  return asked > RETRY_CEILING_MS ? null : asked
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unreferenced for `ProgressReporter`'s reason: a wait roma is sitting
    // through is not a reason to keep the process up.
    setTimeout(resolve, ms).unref?.()
  })
}
