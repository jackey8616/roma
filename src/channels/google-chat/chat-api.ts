export interface ChatPress {
  readonly label: string
  readonly action: string
  readonly parameters: Readonly<Record<string, string>>
}

export interface ChatLink {
  readonly label: string
  readonly url: string
}

export type ChatAction = ChatPress | ChatLink

export interface ChatMessage {
  readonly space: string
  readonly thread: string | null
  readonly text: string
  readonly replyOption?: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'
  readonly actions?: readonly ChatAction[]
  readonly requestId?: string
}

export class ChatRefusal extends Error {
  readonly status: number | null
  readonly retryAfterMs: number | null

  constructor(message: string, status: number | null, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'ChatRefusal'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export interface ChatApi {
  post(message: ChatMessage): Promise<string>

  edit(name: string, text: string): Promise<void>

  download(resourceName: string): Promise<Uint8Array>
}
