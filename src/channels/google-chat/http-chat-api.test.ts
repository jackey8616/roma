import { describe, expect, it } from 'vitest'
import { CHAT_API, HttpChatApi, type ChatRequest } from './http-chat-api.js'

// SEAM 3, the far side: a ChatMessage goes in and what comes out is the HTTP
// request Google would have received. No Workspace, no credential, no quota —
// the token is somebody else's problem by the time a request reaches here, which
// is the whole reason the sender is a seam.
//
// The request shapes below are **from Google's reference documentation**, like
// every other Chat fact in this repo. What they pin down is roma's side of the
// call: the URL it builds, the method, and the body. Whether Chat then does what
// the reference says it does is not something anything here can prove.
// https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages

const SPACE = 'spaces/AAAA'
const THREAD = `${SPACE}/threads/thread-1`
const POSTED = `${SPACE}/messages/msg-1`

/** A sender that records what it was asked to send and answers as Chat would. */
function recording(answer: unknown = { name: POSTED }) {
  const requests: ChatRequest[] = []
  const api = new HttpChatApi({
    send: (request) => {
      requests.push(request)
      return Promise.resolve(answer)
    },
    download: () => Promise.reject(new Error('no download in this test')),
  })
  return { api, requests, last: () => requests.at(-1) }
}

describe('posting a message', () => {
  // The one thing ADR-0004 is emphatic about: an app cannot create a thread of
  // its own, so replying *into* the caller's thread with this option is the only
  // way a thread ever comes to exist. Wrong or missing, roma answers every
  // message at the top level of the space and every Conversation loses its
  // shape.
  it('replies into a thread with the option that establishes it', async () => {
    const { api, last } = recording()

    await api.post({
      space: SPACE,
      thread: THREAD,
      text: 'hello',
      replyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
    })

    expect(last()).toEqual({
      method: 'POST',
      url: `${CHAT_API}/${SPACE}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`,
      body: { text: 'hello', thread: { name: THREAD } },
    })
  })

  // A DM has no threads to speak of, so the message carries neither — and
  // sending a thread name that names a single message would make every reply its
  // own Conversation.
  it('posts plainly into a DM', async () => {
    const { api, last } = recording()

    await api.post({ space: 'spaces/DM-BBBB', thread: null, text: 'hello' })

    expect(last()).toEqual({
      method: 'POST',
      url: `${CHAT_API}/spaces/DM-BBBB/messages`,
      body: { text: 'hello' },
    })
  })

  // The name is the only way to edit the message afterwards, which is the whole
  // of what an acknowledgement is for.
  it('hands back the name Chat gave the message', async () => {
    const { api } = recording()

    await expect(api.post({ space: SPACE, thread: null, text: 'hello' })).resolves.toBe(POSTED)
  })

  // A post that "succeeded" without a name leaves an acknowledgement roma cannot
  // edit, and the failure would surface minutes later as an edit of `undefined`.
  // Refused here, where it still says what went wrong.
  it('refuses a response that carries no message name', async () => {
    const { api } = recording({ notAMessage: true })

    await expect(api.post({ space: SPACE, thread: null, text: 'hello' })).rejects.toThrow(/name/i)
  })

  // Rejecting means the Conversation was not told, which is the one failure the
  // Core does not absorb. Swallowed here it would become a Task that answered
  // nobody and reported success.
  it('lets an API failure through', async () => {
    const api = new HttpChatApi({
      send: () => Promise.reject(new Error('403 permission denied')),
      download: () => Promise.reject(new Error('no download in this test')),
    })

    await expect(api.post({ space: SPACE, thread: null, text: 'hi' })).rejects.toThrow(/403/)
  })
})

describe('the button that takes Overflow', () => {
  // The round trip ADR-0002's valve rests on: the action name and the Task id go
  // out on the button and come back on the click, so roma remembers nothing
  // between offering it and its being taken. `chat-events.ts` reads exactly
  // these two back out.
  it('goes out as a card action carrying the Task id', async () => {
    const { api, last } = recording()

    await api.post({
      space: SPACE,
      thread: null,
      text: 'The shared Claude quota is spent.',
      action: {
        label: 'Run it on metered billing',
        action: 'takeOverflow',
        parameters: { taskId: 'task-7' },
      },
    })

    expect(last()?.body).toMatchObject({
      cardsV2: [
        {
          card: {
            sections: [
              {
                widgets: [
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: 'Run it on metered billing',
                          onClick: {
                            action: {
                              function: 'takeOverflow',
                              parameters: [{ key: 'taskId', value: 'task-7' }],
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    })
  })

  // The text is still the message. A card-only message would say the quota is
  // spent nowhere a notification or a search would find it.
  it('keeps the text alongside the card', async () => {
    const { api, last } = recording()

    await api.post({
      space: SPACE,
      thread: null,
      text: 'The shared Claude quota is spent.',
      action: { label: 'Run it', action: 'takeOverflow', parameters: { taskId: 'task-7' } },
    })

    expect(last()?.body).toMatchObject({ text: 'The shared Claude quota is spent.' })
  })

  it('sends no card where there is nothing to press', async () => {
    const { api, last } = recording()

    await api.post({ space: SPACE, thread: null, text: 'hello' })

    expect(last()?.body).not.toHaveProperty('cardsV2')
  })
})

describe('editing a message', () => {
  // `updateMask` is not optional: without it Chat has no instruction about which
  // field is being replaced, and an acknowledgement that silently stopped
  // updating is exactly what a dead Task looks like.
  it('replaces the text of a message roma posted, by its resource name', async () => {
    const { api, last } = recording({})

    await api.edit(POSTED, 'Working…')

    expect(last()).toEqual({
      method: 'PATCH',
      url: `${CHAT_API}/${POSTED}?updateMask=text`,
      body: { text: 'Working…' },
    })
  })

  it('lets an API failure through', async () => {
    const api = new HttpChatApi({
      send: () => Promise.reject(new Error('404 not found')),
      download: () => Promise.reject(new Error('no download in this test')),
    })

    await expect(api.edit(POSTED, 'Working…')).rejects.toThrow(/404/)
  })
})
