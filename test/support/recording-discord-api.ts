import type { DiscordApi, DiscordPost } from '../../src/channels/discord/discord-api.js'
import type { DiscordMessage } from '../../src/channels/discord/discord-events.js'

/** Which of the six calls a recording is of. */
export type DiscordCall =
  'message' | 'download' | 'post' | 'edit' | 'startThread' | 'acknowledgePress'

/** One press roma said had arrived, by the interaction it answered. */
export interface RecordedAcknowledgement {
  readonly interactionId: string
  readonly token: string
}

/** One message as Discord holds it: what it was posted with, and its text now. */
export interface RecordedDiscordMessage {
  readonly id: string
  readonly posted: DiscordPost
  text: string
  /** How many times it has been edited, which is what "in place" is measured by. */
  edits: number
}

/** One thread roma asked Discord to open. */
export interface RecordedThread {
  readonly channel: string
  readonly message: string
  readonly name: string
}

/**
 * Discord's REST API with the network taken out.
 *
 * The other far side of seam 3: an outbound instruction goes into the Adapter
 * and what comes out is a list of API calls, with no guild, no credential and no
 * rate limit. A test asserting on `messages` is asserting on exactly what a
 * person in the thread would have seen, and one asserting on `calls` is
 * asserting that an acknowledgement was edited rather than posted again.
 *
 * Anything it was not told about **rejects**, which is the important half on the
 * inbound calls: a quoted message roma cannot read is the ordinary case on this
 * Channel, not an edge one — the fetch may be refused, the intent premise behind
 * it is unverified, and an attachment's link expires (ADR-0029).
 */
export class RecordingDiscordApi implements DiscordApi {
  /** Every call in order, so a test can assert that an edit was not a new post. */
  readonly calls: DiscordCall[] = []
  /** Every message roma fetched, as `{channel}/{message}`, in order. */
  readonly fetched: string[] = []
  /** Every attachment URL roma redeemed, in order. */
  readonly downloads: string[] = []
  /** Every message roma posted, in order, with whatever it has been edited to. */
  readonly messages: RecordedDiscordMessage[] = []
  /** Every thread roma asked for, including the ones that already existed. */
  readonly threads: RecordedThread[] = []
  /** Every press roma acknowledged, in order. Three seconds is what it has. */
  readonly acknowledged: RecordedAcknowledgement[] = []

  readonly #messages = new Map<string, DiscordMessage>()
  readonly #content = new Map<string, Uint8Array>()
  readonly #failNext = new Map<DiscordCall, Error>()
  readonly #failEvery = new Map<DiscordCall, Error>()

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

  /** Make the next call of this kind reject, the way an outage or a 429 does. */
  failNext(call: DiscordCall, error: Error): void {
    this.#failNext.set(call, error)
  }

  /** Make every call of this kind reject, for a fault that does not pass. */
  failEvery(call: DiscordCall, error: Error): void {
    this.#failEvery.set(call, error)
  }

  message(channelId: string, messageId: string): Promise<DiscordMessage> {
    const at = `${channelId}/${messageId}`
    this.calls.push('message')
    this.fetched.push(at)
    const refusal = this.#refusal('message')
    if (refusal !== null) return Promise.reject(refusal)
    const message = this.#messages.get(at)
    return message === undefined
      ? Promise.reject(new Error(`no message at ${at}`))
      : Promise.resolve(message)
  }

  download(url: string): Promise<Uint8Array> {
    this.calls.push('download')
    this.downloads.push(url)
    const refusal = this.#refusal('download')
    if (refusal !== null) return Promise.reject(refusal)
    const content = this.#content.get(url)
    return content === undefined
      ? Promise.reject(new Error(`no content at ${url}`))
      : Promise.resolve(content)
  }

  post(message: DiscordPost): Promise<string> {
    this.calls.push('post')
    const refusal = this.#refusal('post')
    if (refusal !== null) return Promise.reject(refusal)
    const id = `posted-${this.messages.length + 1}`
    this.messages.push({ id, posted: message, text: message.text, edits: 0 })
    return Promise.resolve(id)
  }

  edit(channelId: string, messageId: string, text: string): Promise<void> {
    this.calls.push('edit')
    const refusal = this.#refusal('edit')
    if (refusal !== null) return Promise.reject(refusal)
    const message = this.messages.find((candidate) => candidate.id === messageId)
    if (message === undefined) return Promise.reject(new Error(`no such message: ${messageId}`))
    if (message.posted.channel !== channelId) {
      return Promise.reject(new Error(`${messageId} is not in ${channelId}`))
    }
    message.text = text
    message.edits += 1
    return Promise.resolve()
  }

  /**
   * Open a thread, or answer with the one this message already has.
   *
   * The port's own promise, kept the way `HttpDiscordApi` keeps it: *"a message
   * can only have a single thread created from it"*, so a second attempt is a
   * success answering with the thread the first one made. What the real one
   * reads out of a 400 to decide that is asserted in `http-discord-api.test.ts`.
   */
  startThread(channelId: string, messageId: string, name: string): Promise<string> {
    this.calls.push('startThread')
    this.threads.push({ channel: channelId, message: messageId, name })
    const refusal = this.#refusal('startThread')
    if (refusal !== null) return Promise.reject(refusal)
    return Promise.resolve(messageId)
  }

  acknowledgePress(interactionId: string, token: string): Promise<void> {
    this.calls.push('acknowledgePress')
    this.acknowledged.push({ interactionId, token })
    const refusal = this.#refusal('acknowledgePress')
    return refusal === null ? Promise.resolve() : Promise.reject(refusal)
  }

  /** The text of every message, in the order they were posted. */
  get texts(): string[] {
    return this.messages.map((message) => message.text)
  }

  /** What this call was told to fail with, if anything. */
  #refusal(call: DiscordCall): Error | null {
    const once = this.#failNext.get(call)
    if (once !== undefined) {
      this.#failNext.delete(call)
      return once
    }
    return this.#failEvery.get(call) ?? null
  }
}
