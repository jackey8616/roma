import type { ChatAction, ChatApi, ChatMessage } from './chat-api.js'

/** Where the Chat API lives. Tests assert on whole URLs built from this one. */
export const CHAT_API = 'https://chat.googleapis.com/v1'

/**
 * The OAuth scope a Chat app posts under: acting as the app, not as a person.
 * https://developers.google.com/workspace/chat/authenticate-authorize-chat-app
 */
export const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot'

/** One call to the Chat API, with everything but the credential decided. */
export interface ChatRequest {
  readonly method: 'POST' | 'PATCH'
  /** The whole URL, query string included. */
  readonly url: string
  /** The JSON body, as an object: serialising is the sender's. */
  readonly body: Readonly<Record<string, unknown>>
}

/**
 * Whatever puts a token on a request and sends it, resolving to the parsed
 * JSON. Everything above it is roma's decisions about Chat; everything below it
 * is Google's library and its credentials, untestable without a Workspace.
 */
export type SendChatRequest = (request: ChatRequest) => Promise<unknown>

/** Whatever puts a token on a GET and reads the bytes back, unparsed. */
export type DownloadChatMedia = (url: string) => Promise<Uint8Array>

export interface HttpChatApiOptions {
  readonly send: SendChatRequest
  readonly download: DownloadChatMedia
}

/**
 * The Chat API as roma uses it, over HTTP. No state: which message an
 * Acknowledgement lives in is `GoogleChatAdapter`'s to remember.
 */
export class HttpChatApi implements ChatApi {
  readonly #send: SendChatRequest
  readonly #download: DownloadChatMedia

  constructor({ send, download }: HttpChatApiOptions) {
    this.#send = send
    this.#download = download
  }

  /**
   * Post a message and hand back its resource name. Rejects where Chat returns
   * none. `replyOption` goes on the query string, where
   * `spaces.messages.create` documents it.
   */
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
    // Enforced by `fence:gchat-post-refuses-a-nameless-message`.
    if (name === null) throw new Error('Chat accepted the message but returned no resource name')
    return name
  }

  /**
   * Replace the text of a message roma posted.
   *
   * Enforced by `fence:gchat-edit-names-the-field`.
   */
  async edit(name: string, text: string): Promise<void> {
    await this.#send({
      method: 'PATCH',
      url: `${CHAT_API}/${name}?updateMask=text`,
      body: { text },
    })
  }

  /**
   * Fetch an attachment's bytes.
   *
   * **Written from Google's documentation and never run against Chat.** A wrong
   * URL surfaces as a failed Task carrying the HTTP error.
   * https://developers.google.com/workspace/chat/api/reference/rest/v1/media/download
   */
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
