import type { ChatApi, ChatMessage } from '../../src/channels/google-chat/chat-api.js'

export interface RecordedMessage {
  readonly name: string
  readonly posted: ChatMessage
  text: string
  edits: number
}

export class RecordingChatApi implements ChatApi {
  readonly messages: RecordedMessage[] = []
  readonly calls: ('post' | 'edit' | 'download')[] = []
  readonly downloads: string[] = []

  #failNextPost: Error | null = null
  readonly #content = new Map<string, Uint8Array>()

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
    return content === undefined
      ? Promise.reject(new Error(`no content for ${resourceName}`))
      : Promise.resolve(content)
  }

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

  get texts(): string[] {
    return this.messages.map((message) => message.text)
  }
}
