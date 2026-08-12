import type {
  ChannelAdapter,
  ChannelCapabilities,
  IngressMessage,
  OutboundInstruction,
} from '../../channel-adapter.js'
import type { Command } from '../../commands.js'
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
 * **Bounded, and the bound is the point.** ADR-0028 moved the remedy for a
 * failed post into `deliver` because re-reading the event repairs no POST; what
 * that inherits on this Channel is that a 429 counts toward an invalid-request
 * budget of *"10,000 per 10 minutes"* whose penalty is a temporary block on the
 * whole API rather than on the channel that earned it. So a loop that kept
 * trying would turn one unreachable Conversation into an outage of every
 * Conversation, roma's Gateway included (ADR-0029).
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
 * The ceiling is a limit on roma's patience rather than on Discord's: a wait
 * longer than this is a block on the whole API rather than a bucket refilling,
 * and sleeping through one inside `deliver` holds the Task, the Session's
 * Opening and everything queued behind them for as long as it lasts. roma gives
 * up and says so instead.
 */
export const RETRY_FLOOR_MS = 500
export const RETRY_CEILING_MS = 30_000

/**
 * How many Conversations roma keeps the answering address of.
 *
 * **Never take the bound off.** roma runs for weeks and every top-level mention
 * makes a Conversation, so one entry per Conversation ever seen is a leak with
 * no ceiling. What eviction costs is `#answering`'s.
 */
const REMEMBERED = 1_000

/**
 * The instructions after which a Task has no acknowledgement left to keep.
 *
 * Named as a set rather than asked as "not progress", because that is no longer
 * the same question: a blocked Task has been told something and is still
 * running, and its acknowledgement is still the message it will keep editing.
 */
const ENDS_THE_TASK = new Set(['result', 'failure', 'stopped', 'command-outcome', 'choice'])

/** The message roma is answering in one Conversation, and where it arrived. */
interface Answered {
  readonly channel: string
  readonly message: string
  readonly name: string
  /**
   * **Not the channel: the promise of it.** The entry has to exist from the
   * instant the thread is first asked for, or two instructions arriving together
   * both open one — and a message can only ever have the one.
   */
  place: Promise<string> | null
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
  readonly #wait: (ms: number) => Promise<void>

  /**
   * The message roma is answering in each Conversation, by Conversation and
   * Caller.
   *
   * **Keyed by the Caller as well.** A thread is many people sharing one
   * Conversation and two Tasks can be in flight in it at once, so keyed on the
   * Conversation alone Ada's answer replies to Bob's question (ADR-0009). A
   * top-level key names one message and therefore one Caller, so the thread on
   * it is one entry's whichever way this is keyed.
   *
   * **Never persist it, and never leave it unbounded.** An entry that is gone
   * costs the answer its reply and asks Discord a second time for a thread it
   * has already made — which is a success, because a message can only have one.
   * So both a restart and an eviction repair themselves, and the one thing that
   * does not is a Conversation whose thread was never opened at all, where the
   * Task is gone too.
   */
  readonly #answering = new Map<string, Answered>()

  /**
   * Each Task's acknowledgement, as the promise of the message that carries it.
   *
   * The promise rather than the id, so that the entry exists from the instant
   * the first update is sent rather than from when Discord answers. In between,
   * a second update would otherwise find nothing and post a second
   * acknowledgement — and the Task would have two messages mutating at once.
   *
   * Dropped when the Task ends. A post still in flight then resolves into
   * nothing, which is what should happen: the acknowledgement is finished with.
   */
  readonly #acknowledgements = new Map<string, Promise<string>>()

  constructor({ api, wait }: DiscordAdapterOptions) {
    this.#api = api
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
      // A press on a Menu button is a message the Caller did not have to type, so
      // it arrives here rather than through a reader of its own on this
      // interface — pressing is typing (ADR-0023). Asked first because it
      // answers about a different kind of event entirely: the message on a press
      // is roma's *own* card, and the reader below must go on refusing anything
      // an app said rather than being taught an exception to it.
      readChosenOption(event) ??
      readIngressMessage(event, {
        // Bound rather than called: `toIngress` stays synchronous, and what an
        // Enclosure costs is paid once the Core knows the Session and knows the
        // bytes are wanted (ADR-0011).
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
   * Answers null for every press `toIngress` answered — `Ingress.#workFor` tries
   * that one first and only reaches here where it returned null, so the two
   * encodings are told apart by the first field of a `custom_id` and never by
   * which reader was asked (`discord-events.ts`).
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
   * Rejecting means the Conversation was not told, and the Core treats that as
   * the one failure it cannot absorb — so nothing here swallows a refusal it has
   * run out of attempts on.
   */
  async deliver(instruction: OutboundInstruction): Promise<void> {
    const { taskId, conversationKey, caller } = instruction
    const answered = this.#answering.get(addressOf(conversationKey, caller))
    const channel = await this.#place(conversationKey, answered)

    if (instruction.kind === 'progress') {
      await this.#acknowledge(taskId, channel, answered, progressText(instruction.progress))
      return
    }

    // Only where the Task is actually over. `blocked`, `overflow-refused` and
    // `context-full` are messages about a Task that is still going: forgetting
    // its acknowledgement there would strand the one the person is watching and
    // post a second one when the Task started again. Dropped before the messages
    // are posted rather than after, so that a post that throws still leaves
    // nothing behind.
    if (ENDS_THE_TASK.has(instruction.kind)) this.#acknowledgements.delete(taskId)

    // Two messages can carry buttons and they are never the same message: the
    // block that offers Overflow (ADR-0002 puts the valve at the moment of
    // blocking rather than in a setting), and the Menu somebody may choose from
    // (ADR-0023). Which Menus are drawn at all is the Core's — an `/effort` on a
    // model the Effort Matrix says takes none arrives as a `result` rather than
    // a `choice`, so there is nothing here to suppress.
    const buttons =
      instruction.kind === 'blocked' && instruction.overflowOffered
        ? [offerButton(taskId)]
        : instruction.kind === 'choice'
          ? choiceButtons(instruction.chooses, conversationKey, instruction.options)
          : []

    const messages = outcomeMessages(instruction)
    for (const [at, text] of messages.entries()) {
      // The reply on the first piece and nothing on the rest. It is what
      // addresses the Caller here — Discord's own form, where Chat has only a
      // mention — and an answer long enough to split would otherwise notify
      // somebody once per 2000 characters of it (ADR-0029).
      const replyTo = at === 0 ? (answered?.message ?? null) : null
      // On the last piece rather than on every one, for the same reason the
      // reply is on the first: buttons belong under the text that explains them,
      // and a split answer would otherwise repeat the whole Menu under each
      // piece.
      const last = at === messages.length - 1
      await this.#retrying(() =>
        this.#api.post({ channel, text, replyTo, buttons: last ? buttons : [] }),
      )
    }
  }

  /**
   * Keep what an answer to this message will need and no instruction carries.
   *
   * **Never look for it later.** The Task id is minted in the Core after
   * `toIngress` has returned, so nothing downstream links the event roma read to
   * the instruction it is handed (`TaskAddress`) — here is the only place the
   * two are the same thing.
   *
   * **Never skip a press.** The message on one is roma's own card, and answering
   * a press by replying to it reads as it should — but what is really being kept
   * is the *channel the card is in*, which is the only thing that repairs a
   * Conversation whose thread was refused: without it, the answer to a press
   * goes to the id of a thread that was never opened (ADR-0029).
   */
  #remember(event: DiscordEvent, message: IngressMessage): void {
    const channel = asString(event.message['channel_id'])
    const id = asString(event.message['id'])
    if (channel === null || id === null) return

    const at = addressOf(message.conversationKey, message.caller)
    // Deleted before it is set, because a `Map` keeps the order things were
    // *first* put in it: without this, a Conversation somebody has been talking
    // in all day is evicted ahead of one nobody has touched since this morning.
    this.#answering.delete(at)
    if (this.#answering.size >= REMEMBERED) {
      const oldest = this.#answering.keys().next().value
      if (oldest !== undefined) this.#answering.delete(oldest)
    }
    this.#answering.set(at, { channel, message: id, name: threadName(message.text), place: null })
  }

  /** Which channel this Conversation is answered in, opening its thread if it has none. */
  #place(conversationKey: string, answered: Answered | undefined): Promise<string> {
    // Rows one and two of ADR-0029's table: a key that names the channel its
    // message arrived in is already somewhere roma can speak. Row three is the
    // one with work in it — the key is a message's id, and the thread that will
    // carry that id does not exist until roma opens it.
    if (answered === undefined || answered.channel === conversationKey) {
      return Promise.resolve(conversationKey)
    }
    if (answered.place !== null) return answered.place

    const opening = this.#openThread(conversationKey, answered)
    answered.place = opening
    return opening.catch((error: unknown) => {
      // Forgotten so that the next instruction tries again, exactly as a failed
      // acknowledgement is. Kept, one bad minute would leave every later message
      // in this Conversation waiting on a promise that had already rejected.
      if (answered.place === opening) answered.place = null
      throw error
    })
  }

  /**
   * Open the thread a top-level Conversation Key names, or answer with somewhere
   * roma may actually speak.
   *
   * **Never let a refusal here end the delivery.** roma may hold no permission
   * to open threads, the channel may be a forum or media channel where the route
   * does not work at all, or the classifier may have read a thread as top level
   * — and in every one of them the reply belongs in the channel the message
   * arrived in. Thrown instead, an answer somebody paid for reaches nobody;
   * fallen back, only the Session is in the wrong place (ADR-0029).
   */
  async #openThread(conversationKey: string, answered: Answered): Promise<string> {
    try {
      return await this.#retrying(() =>
        this.#api.startThread(answered.channel, conversationKey, answered.name),
      )
    } catch (error) {
      if (!refused(error)) throw error
      return answered.channel
    }
  }

  /** Post the acknowledgement, or edit the one this Task already has. */
  async #acknowledge(
    taskId: string,
    channel: string,
    answered: Answered | undefined,
    text: string,
  ): Promise<void> {
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
    const posting = this.#retrying(() =>
      this.#api.post({ channel, text, replyTo: answered?.message ?? null, buttons: [] }),
    )
    this.#acknowledgements.set(taskId, posting)
    try {
      await posting
    } catch (error) {
      // A post that failed left no message to edit. Forgetting it is what lets
      // the next update try again — kept, every later update for this Task would
      // edit an id that never existed and fail with an error from minutes ago.
      if (this.#acknowledgements.get(taskId) === posting) this.#acknowledgements.delete(taskId)
      throw error
    }
  }

  /** One call, tried again where trying again could work. ADR-0028's remedy, bounded. */
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

/**
 * One Conversation as one Caller is answered in it. See `#answering`.
 *
 * A space separates them because neither half can contain one: both are Discord
 * snowflakes, which are decimal.
 */
function addressOf(conversationKey: string, caller: string): string {
  return `${conversationKey} ${caller}`
}

/**
 * The button that takes Overflow for one Task.
 *
 * **Never name it by the Conversation.** A Conversation can have a second Task
 * blocked behind this one, so "the blocked Task here" would spend money on
 * whichever roma looked at first. Anyone in the Conversation may press it, which
 * is ADR-0002's decision rather than an oversight.
 */
function offerButton(taskId: string): DiscordButton {
  return { label: OVERFLOW_BUTTON, customId: overflowId(taskId) }
}

/**
 * One button per name on a Menu, or none at all where the Menu is wider than one
 * message will hold.
 *
 * **Never draw a Menu in part.** A card carrying the first `MAX_BUTTONS` of a
 * longer one says those are the names there are, and the rest cannot be reached
 * by pressing anything; drawn as nothing it is *correct* rather than degraded,
 * because the text names every name whether or not anything drew it (ADR-0023).
 */
function choiceButtons(
  chooses: Extract<Command, 'model' | 'effort'>,
  conversationKey: string,
  options: readonly string[],
): readonly DiscordButton[] {
  if (options.length > MAX_BUTTONS) return []
  return options.map((option) => ({
    label: option,
    customId: chooseId(chooses, conversationKey, option),
  }))
}

/** Whether Discord refused this on its own terms, rather than failing to serve it. */
function refused(error: unknown): boolean {
  return error instanceof DiscordRefusal && error.status !== 429 && error.status < 500
}

/**
 * How long to wait before trying this again, or null for a call not worth trying
 * again at all.
 *
 * **Never retry what `refused` answers true for.** Every attempt at a 401 or a
 * 403 is another entry in the invalid-request budget whose penalty is a block on
 * the whole API, so a loop over a permission roma does not have is how roma
 * loses the ones it does (ADR-0029).
 *
 * Anything that is not a `DiscordRefusal` never reached Discord to be refused —
 * a socket that failed, a name that did not resolve — and *is* retried, at the
 * cost of a duplicate message where the request in fact arrived. A Conversation
 * told twice is a great deal better than one told nothing about a Turn that has
 * already been paid for.
 */
function waitBefore(error: unknown, attempt: number): number | null {
  if (refused(error)) return null
  const asked = error instanceof DiscordRefusal ? error.retryAfterMs : null
  if (asked === null) return Math.min(RETRY_FLOOR_MS * 2 ** (attempt - 1), RETRY_CEILING_MS)
  return asked > RETRY_CEILING_MS ? null : asked
}

/** Waiting, as everything but a test does it. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unreferenced for `ProgressReporter`'s reason: a wait roma is sitting
    // through is not a reason to keep the process up.
    setTimeout(resolve, ms).unref?.()
  })
}
