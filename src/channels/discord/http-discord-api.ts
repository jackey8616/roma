import type { DiscordApi } from './discord-api.js'
import type { DiscordMessage } from './discord-events.js'

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
 * The two REST calls, over HTTP.
 *
 * The far side of seam 3 and deliberately the whole of what sits behind it:
 * this decides nothing. It puts a token on a request, checks that Discord
 * answered, and hands back what came — everything that could be wrong about
 * *which* request to make was decided before it got here.
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
    const response = await this.#fetch(
      `${this.#apiBase}/channels/${channelId}/messages/${messageId}`,
      {
        headers: {
          // **Never send the bare token.** Discord reads the scheme to decide what
          // kind of credential this is, and a token with no `Bot ` in front of it
          // is refused as unauthorized — which arrives here as a Quotation that
          // silently never resolves.
          authorization: `Bot ${this.#botToken}`,
        },
      },
    )
    if (!response.ok) {
      throw new Error(`Discord answered ${response.status} for a message roma was pointed at`)
    }
    return (await response.json()) as DiscordMessage
  }

  async download(url: string): Promise<Uint8Array> {
    // **Never put the token on this one.** An attachment URL is a signed link on
    // a content host rather than a call to the API, so a credential added here
    // is a credential handed to whatever is on the other end of a URL that
    // arrived in a message.
    const response = await this.#fetch(url)
    if (!response.ok) {
      throw new Error(
        `Discord answered ${response.status} for an attachment — its links expire, and a Task can wait hours`,
      )
    }
    return new Uint8Array(await response.arrayBuffer())
  }
}
