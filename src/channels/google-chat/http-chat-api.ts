import type { ChatAction, ChatApi, ChatMessage } from './chat-api.js'

/**
 * Where the Chat API lives.
 *
 * Exported because the tests assert on whole URLs, and a base they had to
 * rebuild for themselves would let this one drift without anything noticing.
 */
export const CHAT_API = 'https://chat.googleapis.com/v1'

/**
 * The OAuth scope a Chat app posts under.
 *
 * `chat.bot` is the app's own scope: it authorises acting as the Chat app rather
 * than as a person, which is what a service account with domain-wide delegation
 * would be doing instead. roma is an app in a space, so this is the one it wants.
 * https://developers.google.com/workspace/chat/authenticate-authorize-chat-app
 */
export const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot'

/** One call to the Chat API, with everything but the credential decided. */
export interface ChatRequest {
  readonly method: 'POST' | 'PATCH'
  /** The whole URL, query string included. */
  readonly url: string
  /** The JSON body, as an object rather than as bytes: serialising is the sender's. */
  readonly body: Readonly<Record<string, unknown>>
}

/**
 * Whatever puts a token on a request and sends it.
 *
 * A seam rather than a `fetch` call inline, and the seam is drawn here on
 * purpose: everything above it is roma's decisions about Chat — which URL, which
 * method, what JSON — and everything below it is Google's library resolving
 * Application Default Credentials, minting a token, and refreshing it. The first
 * is worth a test and the second cannot have one without a Workspace.
 */
export type SendChatRequest = (request: ChatRequest) => Promise<unknown>

/**
 * Whatever puts a token on a request and reads bytes back.
 *
 * Beside `SendChatRequest` rather than folded into it, because the two are
 * different in the one way that matters at this seam: everything above returns
 * JSON that a caller parses, and this returns a file. Overloading the existing
 * type would make its `Promise<unknown>` mean two things and leave every caller
 * casting to find out which.
 */
export type DownloadChatMedia = (url: string) => Promise<Uint8Array>

export interface HttpChatApiOptions {
  readonly send: SendChatRequest
  readonly download: DownloadChatMedia
}

/**
 * The Chat API as roma uses it, over HTTP.
 *
 * The implementation `chat-api.ts` said would arrive with the ingress
 * subscriber, and it arrives here rather than earlier because it shares the
 * subscriber's credential handling: both are the Chat app authenticating as
 * itself, and splitting that across two tickets would have meant two answers to
 * one question.
 *
 * Two calls and no state. Which message an acknowledgement lives in is
 * `GoogleChatAdapter`'s to remember; all this does is turn a `ChatMessage` into
 * the request Google documents and hand back the name that came out of it.
 */
export class HttpChatApi implements ChatApi {
  readonly #send: SendChatRequest
  readonly #download: DownloadChatMedia

  constructor({ send, download }: HttpChatApiOptions) {
    this.#send = send
    this.#download = download
  }

  /**
   * Post a message and hand back its resource name.
   *
   * `messageReplyOption` rides on the query string rather than in the body,
   * which is where `spaces.messages.create` documents it. It is sent exactly
   * when the message is going into a thread — an app cannot create a thread of
   * its own in Chat, so replying into the caller's thread with this option is
   * the only way a thread ever comes to exist (ADR-0004).
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
    // A post that succeeded without a name leaves an acknowledgement roma cannot
    // edit, and the consequence would otherwise surface minutes later as an edit
    // of `undefined` against an API that has never heard of it.
    if (name === null) throw new Error('Chat accepted the message but returned no resource name')
    return name
  }

  /**
   * Replace the text of a message roma posted.
   *
   * `updateMask=text` is required rather than a nicety: without it Chat is not
   * told which field is being replaced. An acknowledgement that quietly stopped
   * updating is indistinguishable from a Task that died, which is the one thing
   * that message exists to rule out.
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
   * **Written from Google's documentation and never run against Chat** —
   * `media.download` is `GET /v1/media/{resourceName}?alt=media`, and
   * `alt=media` is what asks for the file rather than a JSON description of it.
   * That is the same standard of evidence every other read in this Channel was
   * built on, and it is called out here because this one is new enough that
   * nobody has seen it work. Getting the URL wrong surfaces as a failed Task
   * with the HTTP error in it, which is at least loud.
   * https://developers.google.com/workspace/chat/api/reference/rest/v1/media/download
   */
  async download(resourceName: string): Promise<Uint8Array> {
    return await this.#download(`${CHAT_API}/media/${resourceName}?alt=media`)
  }
}

/**
 * Some actions as the smallest card that can carry them.
 *
 * The one place ADR-0004's "messages are plain text" gives way: Chat has no way
 * to put a button on plain text.
 *
 * One `buttonList` holding all of them rather than one widget each, because that
 * is Chat's own grouping — it wraps a row across lines, which is what a
 * six-level Effort Menu needs on a phone.
 *
 * `action.function` and `action.parameters` are the round trip, which is why
 * roma remembers nothing between offering something and its being taken. Going
 * out they must be `{key, value}` pairs; the click may return either that shape
 * or an object, and `chat-events.ts` reads both.
 * https://developers.google.com/workspace/chat/read-form-data
 */
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

/** The resource name off a Message the API sent back, if it sent one. */
function nameOf(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null
  const name = (answer as { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : null
}
