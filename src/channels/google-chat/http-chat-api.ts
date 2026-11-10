import type { ChatAction, ChatApi, ChatMessage } from './chat-api.js'

export const CHAT_API = 'https://chat.googleapis.com/v1'

export const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot'

export interface ChatRequest {
  readonly method: 'POST' | 'PATCH'
  readonly url: string
  readonly body: Readonly<Record<string, unknown>>
}

export type SendChatRequest = (request: ChatRequest) => Promise<unknown>

export type DownloadChatMedia = (url: string) => Promise<Uint8Array>

export interface HttpChatApiOptions {
  readonly send: SendChatRequest
  readonly download: DownloadChatMedia
}

export class HttpChatApi implements ChatApi {
  readonly #send: SendChatRequest
  readonly #download: DownloadChatMedia

  constructor({ send, download }: HttpChatApiOptions) {
    this.#send = send
    this.#download = download
  }

  async post(message: ChatMessage): Promise<string> {
    const query =
      message.replyOption === undefined ? '' : `?messageReplyOption=${message.replyOption}`
    const answer = await this.#send({
      method: 'POST',
      url: `${CHAT_API}/${message.space}/messages${query}`,
      body: {
        text: message.text,
        ...(message.thread === null ? {} : { thread: { name: message.thread } }),
        ...(message.actions === undefined ? {} : { cardsV2: [cardFor(message.actions)] }),
      },
    })

    const name = nameOf(answer)
    if (name === null) throw new Error('Chat accepted the message but returned no resource name')
    return name
  }

  async edit(name: string, text: string): Promise<void> {
    await this.#send({
      method: 'PATCH',
      url: `${CHAT_API}/${name}?updateMask=text`,
      body: { text },
    })
  }

  async download(resourceName: string): Promise<Uint8Array> {
    return await this.#download(`${CHAT_API}/media/${resourceName}?alt=media`)
  }
}

function cardFor(actions: readonly ChatAction[]): unknown {
  return {
    cardId: 'roma-action',
    card: {
      sections: [
        {
          widgets: [
            {
              buttonList: {
                buttons: actions.map((action) => ({
                  text: action.label,
                  onClick: {
                    action: {
                      function: action.action,
                      parameters: Object.entries(action.parameters).map(([key, value]) => ({
                        key,
                        value,
                      })),
                    },
                  },
                })),
              },
            },
          ],
        },
      ],
    },
  }
}

function nameOf(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null
  const name = (answer as { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : null
}
