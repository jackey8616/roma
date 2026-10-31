import type { DiscordMessage } from './discord-events.js'

export interface DiscordButton {
  readonly label: string
  readonly customId: string
}

export interface DiscordPost {
  readonly channel: string
  readonly text: string
  readonly replyTo: string | null
  readonly buttons: readonly DiscordButton[]
}

export const MAX_BUTTONS = 25

export class DiscordRefusal extends Error {
  readonly status: number
  readonly retryAfterMs: number | null

  constructor(message: string, status: number, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'DiscordRefusal'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export interface DiscordApi {
  message(channelId: string, messageId: string): Promise<DiscordMessage>
  download(url: string): Promise<Uint8Array>
  post(message: DiscordPost): Promise<string>
  edit(channelId: string, messageId: string, text: string): Promise<void>
  startThread(channelId: string, messageId: string, name: string): Promise<string>
  acknowledgePress(interactionId: string, token: string): Promise<void>
}
