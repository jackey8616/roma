export interface ChatAction {
  readonly label: string
  readonly action: string
  readonly parameters: Readonly<Record<string, string>>
}

export interface ChatMessage {
  readonly space: string
  readonly thread: string | null
  readonly text: string
  readonly replyOption?: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'
  readonly actions?: readonly ChatAction[]
}

export interface ChatApi {
  post(message: ChatMessage): Promise<string>

  edit(name: string, text: string): Promise<void>

  download(resourceName: string): Promise<Uint8Array>
}
