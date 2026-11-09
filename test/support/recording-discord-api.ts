import type { DiscordApi, DiscordPost } from '../../src/channels/discord/discord-api.js'
import type { DiscordMessage } from '../../src/channels/discord/discord-events.js'

export type DiscordCall =
  'message' | 'download' | 'post' | 'edit' | 'startThread' | 'acknowledgePress'

export interface RecordedAcknowledgement {
  readonly interactionId: string
  readonly token: string
}

export interface RecordedDiscordMessage {
  readonly id: string
  readonly posted: DiscordPost
  text: string
  edits: number
}

export interface RecordedThread {
  readonly channel: string
  readonly message: string
  readonly name: string
}

export class RecordingDiscordApi implements DiscordApi {
  readonly calls: DiscordCall[] = []
  readonly fetched: string[] = []
  readonly downloads: string[] = []
  readonly messages: RecordedDiscordMessage[] = []
  readonly threads: RecordedThread[] = []
  readonly acknowledged: RecordedAcknowledgement[] = []

  readonly #messages = new Map<string, DiscordMessage>()
  readonly #content = new Map<string, Uint8Array>()
  readonly #failNext = new Map<DiscordCall, Error>()
  readonly #failEvery = new Map<DiscordCall, Error>()

  holds(channelId: string, messageId: string, message: DiscordMessage): void {
    this.#messages.set(`${channelId}/${messageId}`, message)
  }

  holdsAttachment(url: string, content: Uint8Array | string): void {
    this.#content.set(
      url,
      typeof content === 'string' ? new TextEncoder().encode(content) : content,
    )
  }

  failNext(call: DiscordCall, error: Error): void {
    this.#failNext.set(call, error)
  }

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

  get texts(): string[] {
    return this.messages.map((message) => message.text)
  }

  #refusal(call: DiscordCall): Error | null {
    const once = this.#failNext.get(call)
    if (once !== undefined) {
      this.#failNext.delete(call)
      return once
    }
    return this.#failEvery.get(call) ?? null
  }
}
