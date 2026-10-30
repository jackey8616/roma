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
 *
 * Three, because the failure this exists to repair is a blip: a 503 while
 * Discord moves something, or a bucket roma shares with itself during a split
 * answer. A fault that survives three attempts spread over a wait Discord itself
 * named is not transient, and the honest thing then is to reject.
 */
export const ATTEMPTS = 3

/**
 * How long roma waits before a retry Discord gave it no time for, and the
 * longest wait it will sit through at all.
 *
 * The floor is doubled per attempt, and only ever used where the response
 * carried no `Retry-After` — a 503, or a socket that never answered. Where
 * Discord *did* say how long, that is what roma waits, because its per-route
 * limits are dynamic and its reference says *"rate limits should not be hard
 * coded into your app"*.
 *
 * The ceiling is a limit on roma's patience rather than on Discord's: past it,
 * roma gives up and says so.
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
   * the parent channel — and every message in that channel is getting a Session
   * of its own.
   *
   * **The consequence is what this records, not the refusal.** A top-level key
   * is the message's own id, minted on the promise that the thread about to be
   * opened will share it; where none is opened the key names nothing, the next
   * message mints another, and each one is a Session that has never heard of the
   * last. The reply still arrives and no Task fails, so there is nothing for a
   * Conversation to notice and nothing anywhere else in roma that says so
   * (ADR-0029).
   *
   * **`status` is Discord's own number rather than roma's reading of it.** A 403
   * is the dangerous one: roma holds no `CREATE_PUBLIC_THREADS` here, so this is
   * every message in this channel from now until somebody grants it. A 400 is
   * the route refusing the channel's type — either a thread read as top level,
   * which ADR-0029 calls harmless and self-repairing, or a forum, which it
   * argues is never reached and is a fault in the classifier if it is; `channel`
   * is what tells those two apart. Anything else is a refusal nobody predicted,
   * and it is written down as it came rather than filed under a meaning it may
   * not have.
   */
  readonly event: 'thread-unopened'
  /** Where roma is answering instead, and where a missing permission would be. */
  readonly channel: string
  readonly status: number
}

export interface DiscordAdapterOptions {
  /**
   * How roma reaches Discord over HTTP.
   *
   * Both directions: an attachment's bytes are redeemed long after the message
   * was read (ADR-0011), and everything roma ever says on this Channel is a call
   * on this port.
   */
  readonly api: DiscordApi
  /**
   * Where to say that a Conversation is being answered somewhere other than
   * where its key names.
   *
   * Optional the way every other log in this repo is, and defaulted to stderr
   * rather than to silence — which is the one way this differs from Chat's.
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
 * Discord, and one of the two modules in roma that knows Discord exists.
 *
 * A Discord event goes in and an ingress message comes out; an outbound
 * instruction goes in and a Discord API call comes out. Everything
 * Discord-specific is on this side of it — snowflakes, mentions, guilds, the
 * 2000-character limit, the words roma uses — and nothing on the other side has
 * ever heard of any of it.
 *
 * A Conversation Key needs neither minting nor storage here, which is ADR-0029's
 * claim and survives: a key *is* a channel id, or the id of a message a thread
 * is about to take, because a thread and the message it was started from share
 * one id. So the key minted before the thread exists is the id the thread will
 * have, and no lookup and no state stand behind it.
 *
 * What it does keep is `#answering`, and that is a different thing from
 * identity: a message id and a parent channel, so that an answer can reply to
 * the question and a thread can be opened where the question was asked. Both are
 * facts about the message roma is answering, both are learned at the only moment
 * they are available, and losing either costs no Conversation its Session.
 *
 * The other module is the Transport, unlike Chat, where the Adapter is the whole
 * of the Channel. `GatewayTransport` decides the two things a synchronous reader
 * cannot: whether a channel is one of the guild's, and what a Quotation says.
 */
export class DiscordAdapter implements ChannelAdapter<DiscordEvent> {
  /**
   * Both true, and both ADR-0029's declarations rather than hopes: Discord can
   * edit a message it has posted, so progress reporting runs in its full form;
   * and a channel id and a message id are both permanent, so no Conversation Key
   * has to be minted or persisted here.
   */
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

  /**
   * One Discord event as a message for the Core, or null if roma should not
   * answer it.
   *
   * Which events those are is `readIngressMessage`'s business. What matters here
   * is that the Core never sees an event: by this point a guild, a channel, a
   * thread and an @-mention have become a key, a Caller and some text.
   */
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
   * A press on the Overflow button, as the Task it was about.
   *
   * The other half of `offerButton` below: what goes out on the button comes
   * back on the press, so the Task id makes the round trip and roma needs to
   * remember nothing between the offer and its being taken.
   *
   * Answers null for every press `toIngress` answered, and not because it is
   * asked second: one reader reads every `custom_id` and answers one kind, so
   * the order the subscriber asks in decides nothing (`Pressed`).
   */
  toOverflowTaken(event: DiscordEvent): string | null {
    return readOverflowTaken(event)
  }

  /**
   * Carry out one instruction, as one or more Discord messages.
   *
   * Progress edits the acknowledgement in place; everything else is a new
   * message, which is the rule ADR-0003 makes unconditional for a result and
   * this Adapter has no reason to bend for the rest.
   *
   * Everything it posts goes through `#retrying`, because ADR-0028 put the
   * remedy for a failed post here: the Gateway being fine while the REST API
   * answers 503 is the ordinary shape of a Discord outage, and re-reading a
   * socket repairs no POST.
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
