import { ChatRefusal, type ChatAction, type ChatApi, type ChatMessage } from './chat-api.js'

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
    const parameters = new URLSearchParams({
      ...(message.replyOption === undefined ? {} : { messageReplyOption: message.replyOption }),
      ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
    }).toString()
    const query = parameters === '' ? '' : `?${parameters}`
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

export function refusalOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error
  const { response, message } = error as { response?: unknown; message?: unknown }
  const said = typeof message === 'string' ? message : 'Chat could not be reached'
  if (typeof response !== 'object' || response === null) {
    return isUnanswered(error) ? new ChatRefusal(said, null) : error
  }
  const { status, headers } = response as { status?: unknown; headers?: unknown }
  if (typeof status !== 'number') return error
  const seconds = asSeconds(headerOf(headers, 'retry-after'))
  return new ChatRefusal(
    `Chat answered ${status}: ${said}`,
    status,
    seconds === null ? null : Math.round(seconds * 1000),
  )
}

const UNANSWERED = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

function isUnanswered(error: object): boolean {
  const { code } = error as { code?: unknown }
  return typeof code === 'string' && UNANSWERED.has(code)
}

function headerOf(headers: unknown, name: string): string | null {
  if (typeof headers !== 'object' || headers === null) return null
  const { get } = headers as { get?: unknown }
  if (typeof get === 'function') {
    const value: unknown = get.call(headers, name)
    return typeof value === 'string' ? value : null
  }
  const value = (headers as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : null
}

function asSeconds(header: string | null): number | null {
  if (header === null || header.trim() === '') return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}
