import type { ChatApi, ChatMessage } from '../../src/channels/google-chat/chat-api.js'

/** One message as Chat holds it: what it was posted with, and its text now. */
export interface RecordedMessage {
  readonly name: string
  readonly posted: ChatMessage
  text: string
  /** How many times it has been edited, which is what "in place" is measured by. */
  edits: number
}

/**
 * Google Chat with the network taken out.
 *
 * This is the far side of seam 3: an outbound instruction goes into the Adapter
 * and what comes out is a list of API calls, with no Workspace, no credential
 * and no quota. A test asserting on `messages` is asserting on exactly what a
 * person in the space would have seen.
 */
export class RecordingChatApi implements ChatApi {
  readonly messages: RecordedMessage[] = []
  /** Every call in order, so a test can assert that an edit was not a new post. */
  readonly calls: ('post' | 'edit' | 'download')[] = []
  /** Every resource name a download was asked for, in order. */
  readonly downloads: string[] = []

  #failNextPost: Error | null = null
  /** What `download` hands back, keyed by resource name. */
  readonly #content = new Map<string, Uint8Array>()

  /** Give a resource name some bytes, so a test can send an Enclosure. */
  holds(resourceName: string, content: Uint8Array | string): void {
    this.#content.set(
      resourceName,
      typeof content === 'string' ? new TextEncoder().encode(content) : content,
    )
  }

  download(resourceName: string): Promise<Uint8Array> {
    this.calls.push('download')
    this.downloads.push(resourceName)
    const content = this.#content.get(resourceName)
    // Rejecting rather than handing back nothing: an attachment Chat has no
    // bytes for is the shape of every real failure here — a resource that
    // expired, a scope roma does not hold — and a zero-length file would make
    // that look like a success.
    return content === undefined
      ? Promise.reject(new Error(`no content for ${resourceName}`))
      : Promise.resolve(content)
  }

  /** Make the next `post` reject, the way a Chat outage or a quota rejection does. */
  failNextPost(error: Error): void {
    this.#failNextPost = error
  }

  post(message: ChatMessage): Promise<string> {
    this.calls.push('post')
    const failure = this.#failNextPost
    if (failure !== null) {
      this.#failNextPost = null
      return Promise.reject(failure)
    }
    const name = `${message.space}/messages/posted-${this.messages.length + 1}`
    this.messages.push({ name, posted: message, text: message.text, edits: 0 })
    return Promise.resolve(name)
  }

  edit(name: string, text: string): Promise<void> {
    this.calls.push('edit')
    const message = this.messages.find((candidate) => candidate.name === name)
    if (message === undefined) return Promise.reject(new Error(`no such message: ${name}`))
    message.text = text
    message.edits += 1
    return Promise.resolve()
  }

  /** The text of every message, in the order they were posted. */
  get texts(): string[] {
    return this.messages.map((message) => message.text)
  }
}
