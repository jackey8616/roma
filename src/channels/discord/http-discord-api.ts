import {
  DiscordRefusal,
  type DiscordApi,
  type DiscordButton,
  type DiscordPost,
} from './discord-api.js'
import { asNumber, asRecord, asString, type DiscordMessage } from './discord-events.js'

export interface HttpDiscordApiOptions {
  readonly botToken: string
  /** Where the API lives, version included. See `DEFAULT_API_BASE`. */
  readonly apiBase: string
  /**
   * How a request is actually made.
   *
   * The platform's own `fetch` unless something hands in another, which is what
   * lets this file be asserted on without a network. Node ships one, which is
   * the whole reason roma reaches Discord with no dependency at all — the same
   * argument the Gateway client makes about `WebSocket`.
   */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Discord's own code for a message that already has a thread on it.
 *
 * **Never read this as a failure.** Why the second attempt at one message is a
 * success is `startThread`'s promise on the port. The number is off Discord's
 * JSON error code table rather than the route's own documentation — ADR-0029's
 * second tier — and being wrong about it costs a Session its thread and no more.
 */
const THREAD_ALREADY_CREATED = 160004

/**
 * The six REST calls, over HTTP.
 *
 * The far side of seam 3 and deliberately the whole of what sits behind it: this
 * decides nothing. It puts a token on a request, checks that Discord answered,
 * and hands back what came — everything that could be wrong about *which*
 * request to make was decided before it got here.
 *
 * The two things it does read out of a response are the two a caller cannot get
 * anywhere else: how long Discord asked roma to wait, and whether a refused
 * thread was refused because it already exists.
 */
export class HttpDiscordApi implements DiscordApi {
  readonly #botToken: string
  readonly #apiBase: string
  readonly #fetch: typeof globalThis.fetch

  constructor({ botToken, apiBase, fetch }: HttpDiscordApiOptions) {
    this.#botToken = botToken
    this.#apiBase = apiBase
    this.#fetch = fetch ?? globalThis.fetch
  }

  async message(channelId: string, messageId: string): Promise<DiscordMessage> {
    const response = await this.#call(`/channels/${channelId}/messages/${messageId}`)
    refuseUnless(response, 'a message roma was pointed at')
    return (await response.json()) as DiscordMessage
  }

  async download(url: string): Promise<Uint8Array> {
    // **Never put the token on this one.** An attachment URL is a signed link on
    // a content host rather than a call to the API, so a credential added here
    // is a credential handed to whatever is on the other end of a URL that
    // arrived in a message.
    const response = await this.#fetch(url)
    refuseUnless(response, 'an attachment — its links expire, and a Task can wait hours')
    return new Uint8Array(await response.arrayBuffer())
  }

  async post({ channel, text, replyTo, buttons }: DiscordPost): Promise<string> {
    const response = await this.#call(`/channels/${channel}/messages`, 'POST', {
      content: text,
      ...(replyTo === null
        ? {}
        : {
            // **Never let this default.** `fail_if_not_exists` is true unless it
            // is said otherwise, so a reply to a message somebody deleted while
            // the Task ran is not a plainer answer but no answer at all — the
            // Conversation is told nothing about work that has already been paid
            // for.
            message_reference: { message_id: replyTo, fail_if_not_exists: false },
          }),
      ...(buttons.length === 0 ? {} : { components: componentRows(buttons) }),
      ...ALLOWED_MENTIONS,
    })
    refuseUnless(response, 'a message roma tried to post')
    return asString(asRecord(await response.json())?.['id']) ?? ''
  }

  async edit(channelId: string, messageId: string, text: string): Promise<void> {
    const response = await this.#call(`/channels/${channelId}/messages/${messageId}`, 'PATCH', {
      content: text,
      ...ALLOWED_MENTIONS,
    })
    refuseUnless(response, 'an acknowledgement roma tried to edit')
  }

  async startThread(channelId: string, messageId: string, name: string): Promise<string> {
    const response = await this.#call(
      `/channels/${channelId}/messages/${messageId}/threads`,
      'POST',
      { name },
    )
    // A thread and the message it was started from share one id, so a message
    // that already has one is the thread roma was asking for — see `startThread`
    // on the port for why that is a success.
    if (!response.ok && (await codeOf(response)) !== THREAD_ALREADY_CREATED) {
      refuseUnless(response, 'a thread roma tried to open')
    }
    return messageId
  }

  async acknowledgePress(interactionId: string, token: string): Promise<void> {
    const response = await this.#call(`/interactions/${interactionId}/${token}/callback`, 'POST', {
      type: DEFERRED_UPDATE_MESSAGE,
    })
    refuseUnless(response, 'a press roma had three seconds to answer')
  }

  #call(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return this.#fetch(`${this.#apiBase}${path}`, {
      method,
      headers: {
        // **Never send the bare token.** Discord reads the scheme to decide what
        // kind of credential this is, and a token with no `Bot ` in front of it
        // is refused as unauthorized — which arrives here as a Quotation that
        // silently never resolves, or as an answer nobody is ever told.
        authorization: `Bot ${this.#botToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
}

/**
 * Discord's answer to a press that changes nothing about the card.
 *
 * *"For components, ACK an interaction and edit the original message later; the
 * user does not see a loading state"* — which is exactly right for a design
 * where pressing is typing and the card should not move (ADR-0029). Every other
 * callback type either posts something or shows a spinner, and both would have
 * roma answering a Command twice.
 */
const DEFERRED_UPDATE_MESSAGE = 6

/**
 * Discord's numbers for the two things a card is made of.
 *
 * A row is a container and a button is what goes in one; the style is the plain
 * grey. Nothing here is a decision — which buttons exist and what they say was
 * settled before this file saw them.
 */
const ACTION_ROW = 1
const BUTTON = 2
const SECONDARY = 2

/**
 * How many buttons fit in one row.
 *
 * **Never let a row go past five.** Discord refuses the whole message, so a row
 * one button too wide is a Menu nobody is shown. The Model Menu is four and the
 * Effort Menu six, so one row and two.
 *
 * How many rows there may be is `MAX_BUTTONS`, and it is kept where the buttons
 * are chosen rather than trimmed here: dropping a tail is a decision, and this
 * file makes none.
 */
const PER_ROW = 5

/** Buttons as Discord takes them: rows of five, in the order they were given. */
function componentRows(buttons: readonly DiscordButton[]): unknown[] {
  const rows: unknown[] = []
  for (let at = 0; at < buttons.length; at += PER_ROW) {
    rows.push({
      type: ACTION_ROW,
      components: buttons.slice(at, at + PER_ROW).map(({ label, customId }) => ({
        type: BUTTON,
        style: SECONDARY,
        label,
        custom_id: customId,
      })),
    })
  }
  return rows
}

/**
 * What roma will let a message of its own mention.
 *
 * **Never let the text decide it.** A Result is written by a model that has read
 * whatever anybody put in front of it, so an `@everyone` in one is a
 * notification to a whole guild that nobody can take back — which is why an
 * empty `parse` is a decision ADR-0029 records rather than a precaution taken
 * here. `replied_user` is on because naming this field at all is what turns the
 * reply ping off, and the reply is how a Caller is addressed on this Channel.
 */
const ALLOWED_MENTIONS = { allowed_mentions: { parse: [], replied_user: true } } as const

/** Discord's own error code on a response, or null where it said none. */
async function codeOf(response: Response): Promise<number | null> {
  try {
    return asNumber(asRecord(await response.clone().json())?.['code'])
  } catch {
    return null
  }
}

/**
 * Turn anything but a success into the refusal a retry can read.
 *
 * **Never let a wait be inferred instead of read.** This is the one place a
 * `Retry-After` comes off a response, and `DiscordRefusal` is where what a
 * guessed one costs is written down. `retry-after` is Discord's answer to a 429
 * and `x-ratelimit-reset-after` is the same figure on the bucket it belongs to;
 * both are seconds, and either may be fractional.
 */
function refuseUnless(response: Response, what: string): void {
  if (response.ok) return
  const seconds =
    asSeconds(response.headers.get('retry-after')) ??
    asSeconds(response.headers.get('x-ratelimit-reset-after'))
  throw new DiscordRefusal(
    `Discord answered ${response.status} for ${what}`,
    response.status,
    seconds === null ? null : Math.round(seconds * 1000),
  )
}

/** A header that should hold a number of seconds, or null for one that does not. */
function asSeconds(header: string | null): number | null {
  if (header === null) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}
