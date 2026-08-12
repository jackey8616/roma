import type { DiscordApi } from '../../src/channels/discord/discord-api.js'
import type { DiscordMessage } from '../../src/channels/discord/discord-events.js'

/**
 * Discord's REST API with the network taken out.
 *
 * The other far side of seam 3: roma asks for the message behind a Quotation or
 * the bytes behind an Enclosure, and what comes back is whatever a test decided
 * Discord holds. A test asserting on `fetched` is asserting on exactly which
 * round trips a message cost.
 *
 * Anything it was not told about **rejects**, which is the important half: a
 * quoted message roma cannot read is the ordinary case on this Channel, not an
 * edge one — the fetch may be refused, the intent premise behind it is
 * unverified, and an attachment's link expires (ADR-0029).
 */
export class RecordingDiscordApi implements DiscordApi {
  /** Every message roma fetched, as `{channel}/{message}`, in order. */
  readonly fetched: string[] = []
  /** Every attachment URL roma redeemed, in order. */
  readonly downloads: string[] = []

  readonly #messages = new Map<string, DiscordMessage>()
  readonly #content = new Map<string, Uint8Array>()

  /** Give an address a message, so that a test can quote one. */
  holds(channelId: string, messageId: string, message: DiscordMessage): void {
    this.#messages.set(`${channelId}/${messageId}`, message)
  }

  /** Give an attachment URL some bytes, so that a test can send an Enclosure. */
  holdsAttachment(url: string, content: Uint8Array | string): void {
    this.#content.set(
      url,
      typeof content === 'string' ? new TextEncoder().encode(content) : content,
    )
  }

  message(channelId: string, messageId: string): Promise<DiscordMessage> {
    const at = `${channelId}/${messageId}`
    this.fetched.push(at)
    const message = this.#messages.get(at)
    return message === undefined
      ? Promise.reject(new Error(`no message at ${at}`))
      : Promise.resolve(message)
  }

  download(url: string): Promise<Uint8Array> {
    this.downloads.push(url)
    const content = this.#content.get(url)
    return content === undefined
      ? Promise.reject(new Error(`no content at ${url}`))
      : Promise.resolve(content)
  }
}
