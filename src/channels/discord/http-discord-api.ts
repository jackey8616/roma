import {
  DiscordRefusal,
  type DiscordApi,
  type DiscordButton,
  type DiscordPost,
} from './discord-api.js'
import { asNumber, asRecord, asString, type DiscordMessage } from './discord-events.js'

export interface HttpDiscordApiOptions {
  readonly botToken: string
  readonly apiBase: string
  readonly fetch?: typeof globalThis.fetch
}

const THREAD_ALREADY_CREATED = 160004

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

const ALLOWED_MENTIONS = { allowed_mentions: { parse: [], replied_user: true } } as const

async function codeOf(response: Response): Promise<number | null> {
  try {
    return asNumber(asRecord(await response.clone().json())?.['code'])
  } catch {
    return null
  }
}

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
