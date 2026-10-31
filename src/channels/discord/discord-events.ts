import type { IngressMessage, PendingEnclosure, Quotation } from '../../channel-adapter.js'
import { commandFor, type Command } from '../../commands.js'
import { reasonOf, type OperatorLog } from '../../operator-log.js'

/**
 * One message as Discord sends it. Left open because the shape is Discord's and
 * it adds fields; everything roma reads out of one is read in this file, so a
 * change in Discord's shape breaks in one place.
 */
export type DiscordMessage = Readonly<Record<string, unknown>>

/**
 * One Discord message with the three things the Adapter cannot work out for
 * itself already answered by the Transport.
 */
export interface DiscordEvent {
  readonly message: DiscordMessage
  /** roma's own user id, as `READY` named it: what the mention is found and stripped by. */
  readonly self: string
  /**
   * Whether `channel_id` is one of the guild's own channels, which is what the
   * Conversation Key is derived from. False for a direct message.
   */
  readonly guildChannel: boolean
  /** The passage this message quotes, already completed. See `completedQuotation`. */
  readonly quotation: Quotation | null
  /**
   * The press this event is, or null where it is somebody's own message: what
   * tells the two readers below apart.
   */
  readonly press: DiscordPress | null
}

/**
 * A button roma posted, pressed: who sent it and what it says. Which Conversation
 * it is in is on the button, in `customId`.
 */
export interface DiscordPress {
  /**
   * Whoever pressed it, which is never the card's author.
   *
   * Discord puts them on `member` in a guild and on `user` in a direct message,
   * and `readInteraction` reads both.
   *
   * Enforced by `fence:discord-presser-off-the-event`.
   */
  readonly caller: string
  readonly callerName: string | null
  /** The button's own `custom_id`, exactly as it went out. See `chooseId`. */
  readonly customId: string
}

/**
 * One press off the socket, before roma has answered it. `id` and `token` are the
 * Transport's alone and never reach a `DiscordEvent`.
 */
export interface Interaction {
  /**
   * What names this Delivery — the interaction's own id, never the card's.
   *
   * Enforced by `fence:discord-delivery-named-by-press`.
   */
  readonly id: string
  /** What the acknowledgement is sent with, and it is good for three seconds. */
  readonly token: string
  /** The card the button is on, which is roma's own message. */
  readonly message: DiscordMessage
  readonly press: DiscordPress
}

const MESSAGE_COMPONENT = 3

/**
 * How long a `custom_id` may be, which is *"1-100 characters"*. Nothing at runtime
 * enforces it.
 *
 * Enforced by `fence:discord-custom-id-fits`.
 */
export const MAX_CUSTOM_ID = 100

const CHOOSE = 'choose'
const TAKE_OVERFLOW = 'overflow'

const FIELD = ':'

/**
 * What one press means, which is the whole of what a `custom_id` carries back.
 * Every id is written by `pressId` and read by `readPress`, one `switch` over one
 * tag, so no id is both kinds.
 *
 * Enforced by `fence:discord-press-is-one-kind`.
 */
export type Pressed =
  | {
      readonly kind: typeof CHOOSE
      readonly chooses: Extract<Command, 'model' | 'effort' | 'caveman'>
      readonly conversationKey: string
      readonly option: string
    }
  | { readonly kind: typeof TAKE_OVERFLOW; readonly taskId: string }

/**
 * What a Menu button carries, which is the Command and the Conversation both.
 * The option goes last, and is rejoined on the way back.
 *
 * Enforced by `fence:discord-press-survives-thread-fallback`.
 * Enforced by `fence:discord-option-rides-last`.
 */
export function chooseId(
  chooses: Extract<Command, 'model' | 'effort' | 'caveman'>,
  conversationKey: string,
  option: string,
): string {
  return pressId({ kind: CHOOSE, chooses, conversationKey, option })
}

/**
 * What the Overflow button carries, which is the Task and nothing else.
 *
 * A Task id roma minted and put on the offer, so a press can only ever answer an
 * offer roma actually made.
 *
 * Enforced by `fence:discord-overflow-named-by-task`.
 */
export function overflowId(taskId: string): string {
  return pressId({ kind: TAKE_OVERFLOW, taskId })
}

function pressId(pressed: Pressed): string {
  return pressed.kind === CHOOSE
    ? [CHOOSE, pressed.chooses, pressed.conversationKey, pressed.option].join(FIELD)
    : [TAKE_OVERFLOW, pressed.taskId].join(FIELD)
}

/**
 * What one `custom_id` means, or null for one roma did not put out.
 *
 * The only reading of one there is, which is what makes `Pressed`'s claim true:
 * both readers below are this plus a question about the kind, so neither can
 * accept an id the other also accepts, whichever order they are asked in.
 *
 * Null covers a press on a card from an application that is not roma, a tag from
 * a version of roma that encoded something else, and every id that carries a tag
 * roma knows and nothing usable after it.
 */
export function readPress(customId: string): Pressed | null {
  const [tag, ...rest] = customId.split(FIELD)
  switch (tag) {
    case CHOOSE:
      return chosen(rest)
    case TAKE_OVERFLOW:
      return taken(rest)
    default:
      return null
  }
}

function chosen([chooses, conversationKey, ...rest]: readonly string[]): Pressed | null {
  // Enforced by `fence:discord-menu-door-opens-only-menus`. Enforced by `fence:discord-every-menu-name-reads-back`.
  if (chooses !== 'model' && chooses !== 'effort' && chooses !== 'caveman') return null
  if (conversationKey === undefined || conversationKey === '') return null
  const option = rest.join(FIELD)
  return option === '' ? null : { kind: CHOOSE, chooses, conversationKey, option }
}

function taken(rest: readonly string[]): Pressed | null {
  const taskId = rest.join(FIELD)
  return taskId === '' ? null : { kind: TAKE_OVERFLOW, taskId }
}

/**
 * Read one `INTERACTION_CREATE` payload as a press, or null if it is not one
 * roma answers.
 */
export function readInteraction(payload: Readonly<Record<string, unknown>>): Interaction | null {
  if (asNumber(payload['type']) !== MESSAGE_COMPONENT) return null

  const id = asString(payload['id'])
  const token = asString(payload['token'])
  const customId = asString(asRecord(payload['data'])?.['custom_id'])
  const message = asRecord(payload['message'])
  // `member` in a guild and `user` in a direct message, and neither is the card's
  // author — see `DiscordPress.caller`.
  const user = asRecord(asRecord(payload['member'])?.['user']) ?? asRecord(payload['user'])
  const caller = asString(user?.['id'])
  if (id === null || token === null || customId === null || message === null || caller === null) {
    return null
  }

  return { id, token, message, press: { caller, callerName: displayName(user), customId } }
}

/** Fetch the bytes behind one attachment, by the URL Discord gave it. */
export type DownloadAttachment = (url: string) => Promise<Uint8Array>

/** Fetch one message roma was pointed at, by the channel and message it lives in. */
export type FetchMessage = (channelId: string, messageId: string) => Promise<DiscordMessage>

/** What completing a Quotation can tell an operator that a Conversation cannot. */
export type DiscordEventLogRecord = {
  /** A message quoted another and roma could not fetch the words behind it. */
  readonly event: 'quote-unfetched'
  readonly reason: string
}

/** What reading an event needs beyond the event. */
export interface ReadOptions {
  /** How to fetch an attachment's bytes. Absent, a read produces no Enclosures. */
  readonly download?: DownloadAttachment
}

/**
 * Read one Discord event as a message for the Core, or null if roma should not
 * answer it: a guild, a channel, a thread, an author and an @-mention go in, and
 * a key, a Caller and some text come out.
 *
 * Null covers everything roma is delivered and does not answer: another app
 * talking (roma itself included, or two bots in one channel talk to each other),
 * anything in a guild that did not address roma, and a message with nothing in it.
 */
export function readIngressMessage(
  event: DiscordEvent,
  { download }: ReadOptions = {},
): IngressMessage | null {
  const { message, self, guildChannel, quotation } = event

  const author = asRecord(message['author'])
  const caller = asString(author?.['id'])
  if (caller === null) return null
  // `bot` marks an application, and a webhook id marks a message posted through
  // one — two ways of saying the same thing, and roma's own messages carry the
  // first. Neither is a person asking for anything.
  if (author?.['bot'] === true || message['webhook_id'] !== undefined) return null

  const channelId = asString(message['channel_id'])
  const messageId = asString(message['id'])
  if (channelId === null || messageId === null) return null

  const guildId = asString(message['guild_id'])
  if (guildId !== null && !addressed(message, self)) return null

  const conversationKey = guildChannel ? messageId : channelId

  const text = withoutMention(asString(message['content']) ?? '', self)
  const enclosures = readEnclosures(message, download)
  // Chat's rule, and the same argument: a message with nothing in it is not a
  // request, and "nothing in it" is not "no text in it" — a pasted screenshot
  // and a quoted error are both somebody asking something (ADR-0011, ADR-0021).
  if (text === '' && enclosures.length === 0 && quotation === null) return null

  return {
    conversationKey,
    caller,
    // Neither half is parsed, compared or decided by — see `IngressMessage`.
    // `global_name` is the name Discord shows and `username` is what is left
    // for an account that has none.
    callerName: displayName(author),
    text,
    enclosures,
    quotation,
  }
}

/**
 * Read a press on a Menu button as the message the Caller would have typed, or
 * null if this event is not one. What comes out is an ordinary Ingress Message
 * carrying, say, `/model opus`.
 *
 * Enforced by `fence:discord-press-has-its-own-reader`.
 */
export function readChosenOption(event: DiscordEvent): IngressMessage | null {
  const { press } = event
  if (press === null) return null
  const pressed = readPress(press.customId)
  if (pressed?.kind !== CHOOSE) return null

  return {
    // Enforced by `fence:discord-press-survives-thread-fallback`.
    conversationKey: pressed.conversationKey,
    caller: press.caller,
    callerName: press.callerName,
    text: commandFor(pressed.chooses, pressed.option),
    enclosures: [],
    quotation: null,
  }
}

/** Read a press on the Overflow button as the Task it was about, or null. */
export function readOverflowTaken(event: DiscordEvent): string | null {
  const { press } = event
  if (press === null) return null
  const pressed = readPress(press.customId)
  return pressed?.kind === TAKE_OVERFLOW ? pressed.taskId : null
}

/**
 * Complete the passage this message quotes, or answer that there is none,
 * fetching it over REST where it arrived empty. Run it before `toIngress`.
 *
 * **A fetch that fails or is refused yields no Quotation at all**, logged as
 * `quote-unfetched`. A forwarded passage comes back with `author: null`, because
 * `message_snapshots` excludes the author.
 */
export async function completedQuotation(
  message: DiscordMessage,
  { fetchMessage, log }: CompleteOptions,
): Promise<Quotation | null> {
  const forwarded = asRecord(asRecord(first(message['message_snapshots']))?.['message'])
  const forwardedText = words(forwarded?.['content'])
  if (forwardedText !== null) return { text: forwardedText, author: null }

  // A reply to one of roma's own messages arrives whole — the app's own messages
  // are exempt from the same gate its mentions are — so the round trip is spent
  // only where there is something to fetch.
  const referenced = asRecord(message['referenced_message'])
  const referencedText = words(referenced?.['content'])
  if (referencedText !== null) {
    return { text: referencedText, author: displayName(asRecord(referenced?.['author'])) }
  }

  const reference = asRecord(message['message_reference'])
  const quotedId = asString(reference?.['message_id'])
  if (quotedId === null) return null
  // The reference names the channel for a forward from somewhere else, and
  // carries none for a reply in this one.
  const quotedIn = asString(reference?.['channel_id']) ?? asString(message['channel_id'])
  if (quotedIn === null) return null

  try {
    const quoted = await fetchMessage(quotedIn, quotedId)
    const text = words(quoted['content'])
    return text === null ? null : { text, author: displayName(asRecord(quoted['author'])) }
  } catch (error) {
    log?.({ event: 'quote-unfetched', reason: reasonOf(error) })
    return null
  }
}

/** What completing a Quotation needs beyond the message. */
export interface CompleteOptions {
  readonly fetchMessage: FetchMessage
  readonly log?: OperatorLog<DiscordEventLogRecord>
}

/** Enforced by `fence:discord-addressed-by-either-half`. */
function addressed(message: DiscordMessage, self: string): boolean {
  const mentions = message['mentions']
  const named =
    Array.isArray(mentions) && mentions.some((user) => asString(asRecord(user)?.['id']) === self)
  const content = asString(message['content']) ?? ''
  return named || mentionsOf(self).some((mention) => content.includes(mention))
}

/** Enforced by `fence:discord-strips-only-its-own-mention`. */
function withoutMention(content: string, self: string): string {
  return mentionsOf(self)
    .reduce((text, mention) => text.replaceAll(mention, ''), content)
    .trim()
}

/** Both spellings of one mention: Discord still sends the older one. */
function mentionsOf(id: string): readonly string[] {
  return [`<@${id}>`, `<@!${id}>`]
}

function readEnclosures(
  message: DiscordMessage,
  download: DownloadAttachment | undefined,
): readonly PendingEnclosure[] {
  const attachments = message['attachments']
  if (!Array.isArray(attachments) || download === undefined) return []

  const enclosures: PendingEnclosure[] = []
  for (const entry of attachments) {
    const attachment = asRecord(entry)
    const url = asString(attachment?.['url'])
    if (url === null) continue
    // Enforced by `fence:enclosures-name-is-minted`.
    const name = asString(attachment?.['filename']) ?? 'attachment'
    enclosures.push({ name, from: null, redeem: () => download(url) })
  }
  return enclosures
}

function displayName(user: Readonly<Record<string, unknown>> | null | undefined): string | null {
  return asString(user?.['global_name']) ?? asString(user?.['username'])
}

function words(value: unknown): string | null {
  const text = (asString(value) ?? '').trim()
  return text === '' ? null : text
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : null
}

/**
 * The three readings every Discord payload needs, exported for the Transport,
 * which reads Gateway frames: one copy, so "absent" and "the wrong type" keep
 * meaning the same thing in both files.
 */
export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Readonly<Record<string, unknown>>
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
