import type { IngressMessage, PendingEnclosure, Quotation } from '../../channel-adapter.js'
import { reasonOf, type OperatorLog } from '../../operator-log.js'

/**
 * One message as Discord sends it.
 *
 * Left open for the reason `ChatEvent` is: the shape is not ours. Discord adds
 * fields, and a message arrives inside a Gateway dispatch rather than on its
 * own. Everything roma reads out of one is read below, so a change in Discord's
 * shape breaks in one place rather than everywhere.
 */
export type DiscordMessage = Readonly<Record<string, unknown>>

/**
 * One Discord message with the three things the Adapter cannot work out for
 * itself already answered.
 *
 * All three are the Transport's, which is what makes this Channel's Transport
 * unlike Chat's: that one decodes an envelope, and this one decides things
 * (ADR-0029). Who roma is and which channels the guild has both arrive over the
 * same socket the message did; the Quotation costs a REST call, and `toIngress`
 * does no I/O.
 */
export interface DiscordEvent {
  readonly message: DiscordMessage
  /**
   * roma's own user id, as `READY` named it.
   *
   * What the mention is found and stripped by. Never configured: an application
   * that had to be told its own id is one that can be told the wrong one, and
   * the Gateway says it on every connection anyway.
   */
  readonly self: string
  /**
   * Whether `channel_id` is one of the guild's own channels.
   *
   * The classifier, in the polarity ADR-0029 chose: the guild's channel list is
   * complete and its thread list holds only the *active* threads, so "is this
   * one of the guild's channels" is answerable and "is this a thread" is not.
   * False for a direct message, which has no guild to ask about.
   */
  readonly guildChannel: boolean
  /** The passage this message quotes, already completed. See `completedQuotation`. */
  readonly quotation: Quotation | null
}

/** Fetch the bytes behind one attachment, by the URL Discord gave it. */
export type DownloadAttachment = (url: string) => Promise<Uint8Array>

/** Fetch one message roma was pointed at, by the channel and message it lives in. */
export type FetchMessage = (channelId: string, messageId: string) => Promise<DiscordMessage>

/** What completing a Quotation can tell an operator that a Conversation cannot. */
export type DiscordEventLogRecord = {
  /**
   * A message quoted another and roma could not read the words behind it.
   *
   * The one unverified premise ADR-0029 actually rests on, made visible. Without
   * the message-content intent the quoted message arrives empty, so roma fetches
   * it over REST — and whether REST reads are gated by that intent is stated
   * nowhere anybody has read (#170). If they are, every Quotation on this
   * Channel silently becomes no Quotation, which is a roma answering "what do
   * you think about this?" without the *this*. This line is the difference
   * between that and a fault nobody can see.
   */
  readonly event: 'quote-unfetched'
  readonly reason: string
}

/** What reading an event needs beyond the event. */
export interface ReadOptions {
  /**
   * How to fetch an attachment's bytes, or absent where roma cannot.
   *
   * Optional so that reading an event stays a pure function in the tests that
   * only care about keys and text, exactly as Chat's is. A read with no
   * downloader produces no Enclosures.
   */
  readonly download?: DownloadAttachment
}

/**
 * Read one Discord event as a message for the Core, or null if roma should not
 * answer it.
 *
 * This is where a Channel stops existing: a guild, a channel, a thread, an
 * author and an @-mention go in, and what comes out is a key, a Caller and some
 * text.
 *
 * Null covers everything roma is delivered and does not answer: another app
 * talking — including roma itself, which is how two bots in one channel talk to
 * each other until somebody notices — anything in a guild that did not address
 * roma, and a message with nothing in it.
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

  // A guild message roma was not addressed in is not roma's to answer, and
  // without the message-content intent it arrives empty anyway — so this is the
  // decision ADR-0029 made said out loud rather than left to a side effect of
  // the intents. A direct message needs no mention: being sent one *is* the
  // address.
  const guildId = asString(message['guild_id'])
  if (guildId !== null && !addressed(message, self)) return null

  // The whole of the table in ADR-0029: a message in one of the guild's own
  // channels is keyed on **its own id**, because that is the id the thread roma
  // opens from it will have — "The created thread and the message it was started
  // from will share the same id". Everything else is already a place roma can
  // reply in, and is keyed on the place.
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
 * Complete the passage this message quotes, or answer that there is none.
 *
 * Both of ADR-0021's cases exist on Discord and neither arrives usable: the
 * quoted message is somebody else's and does not mention roma, so its content is
 * empty under the no-privileged-intent decision. So roma fetches it over REST
 * and completes the event **before** `toIngress` reads it, which is what keeps
 * that function synchronous and reading a whole event (ADR-0029).
 *
 * **A fetch that fails or is refused yields no Quotation at all.** The fallback
 * and not supporting Quotations are deliberately one code path, which is what
 * makes the unverified premise behind the fetch a question rather than a risk.
 *
 * A forwarded passage carries no author — `message_snapshots` excludes it — and
 * comes back with `author: null` rather than with a guess, because unattributed
 * words in front of the model are read as the Caller's own and an invented
 * attribution is the one thing worse than none.
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

/**
 * Whether this message addressed roma.
 *
 * **Never read only one of the two.** `mentions` is the documented list and the
 * literal in the content is what survives a payload carrying no list, and a
 * reader that took either on its own answers nothing at all on whichever half of
 * the deliveries carries the other.
 */
function addressed(message: DiscordMessage, self: string): boolean {
  const mentions = message['mentions']
  const named =
    Array.isArray(mentions) && mentions.some((user) => asString(asRecord(user)?.['id']) === self)
  const content = asString(message['content']) ?? ''
  return named || mentionsOf(self).some((mention) => content.includes(mention))
}

/**
 * The message with roma's own mention taken out.
 *
 * **Never leave it in.** Discord does not strip it, unlike Chat's
 * `argumentText`, and `readCommand` matches the whole message — so `<@…> /stop`
 * matches nothing and becomes a paid Task (ADR-0023).
 *
 * **Never take out anybody else's.** Those are content somebody typed, and
 * removing one edits what the model is asked about.
 */
function withoutMention(content: string, self: string): string {
  return mentionsOf(self)
    .reduce((text, mention) => text.replaceAll(mention, ''), content)
    .trim()
}

/** Both spellings of one mention: Discord still sends the older one. */
function mentionsOf(id: string): readonly string[] {
  return [`<@${id}>`, `<@!${id}>`]
}

/** What was sent alongside the text, with `from` null on every one (ADR-0029). */
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
    // Printed and never made into a path — see `PendingEnclosure`.
    const name = asString(attachment?.['filename']) ?? 'attachment'
    enclosures.push({ name, from: null, redeem: () => download(url) })
  }
  return enclosures
}

/** Whoever Discord says this is, as a person reads them, or null. */
function displayName(user: Readonly<Record<string, unknown>> | null | undefined): string | null {
  return asString(user?.['global_name']) ?? asString(user?.['username'])
}

/** Some text with something in it, or null for a field that is empty or absent. */
function words(value: unknown): string | null {
  const text = (asString(value) ?? '').trim()
  return text === '' ? null : text
}

/** The first entry of something that may not be a list at all. */
function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : null
}

/**
 * The three readings every Discord payload needs, exported for the one other
 * file that reads one.
 *
 * A Gateway frame and a message are the same kind of thing to a reader — fields
 * of unknown type off an object that may not be an object — and the Transport
 * reads frames for the same reason this file reads messages. Two copies of these
 * would be two places for "absent" and "the wrong type" to stop meaning the same
 * thing.
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
