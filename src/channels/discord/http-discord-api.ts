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
   * How a request is actually made. The platform's own `fetch` unless a test
   * hands in another; Node's is why roma reaches Discord with no dependency.
   */
  readonly fetch?: typeof globalThis.fetch
}

/** Enforced by `fence:discord-thread-already-created-is-success`. */
const THREAD_ALREADY_CREATED = 160004

/**
 * The six REST calls, over HTTP. Decides nothing: it puts a token on a request,
 * checks that Discord answered, and hands back what came.
 *
 * Any refusal throws `DiscordRefusal`, carrying how long Discord asked roma to
 * wait where it said. A thread refused because it already exists is a success.
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
    // Enforced by `fence:discord-download-carries-no-token`.
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
            // Enforced by `fence:discord-reply-survives-deleted-message`.
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
        // Enforced by `fence:discord-bot-token-scheme`.
        authorization: `Bot ${this.#botToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
}

const DEFERRED_UPDATE_MESSAGE = 6

const ACTION_ROW = 1
const BUTTON = 2
const SECONDARY = 2

/** Enforced by `fence:discord-buttons-fit-one-message`. Enforced by `fence:discord-http-trims-no-menu`. */
const PER_ROW = 5

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

/** Enforced by `fence:discord-text-mentions-nobody`. */
const ALLOWED_MENTIONS = { allowed_mentions: { parse: [], replied_user: true } } as const

async function codeOf(response: Response): Promise<number | null> {
  try {
    return asNumber(asRecord(await response.clone().json())?.['code'])
  } catch {
    return null
  }
}

/** Enforced by `fence:discord-retry-after-is-read`. */
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

function asSeconds(header: string | null): number | null {
  if (header === null) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}
