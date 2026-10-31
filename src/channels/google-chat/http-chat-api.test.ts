import { describe, expect, it } from 'vitest'
import { CHAT_API, HttpChatApi, type ChatRequest } from './http-chat-api.js'

const SPACE = 'spaces/AAAA'
const THREAD = `${SPACE}/threads/thread-1`
const POSTED = `${SPACE}/messages/msg-1`

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

  it('posts plainly into a DM', async () => {
    const { api, last } = recording()

    await api.post({ space: 'spaces/DM-BBBB', thread: null, text: 'hello' })

    expect(last()).toEqual({
      method: 'POST',
      url: `${CHAT_API}/spaces/DM-BBBB/messages`,
      body: { text: 'hello' },
    })
  })

  it('hands back the name Chat gave the message', async () => {
    const { api } = recording()

    await expect(api.post({ space: SPACE, thread: null, text: 'hello' })).resolves.toBe(POSTED)
  })

  it('refuses a response that carries no message name [fence:gchat-post-refuses-a-nameless-message]', async () => {
    const why =
      'A post Chat accepted without a resource name must throw at the post (ADR-0010: the ' +
      'acknowledgement is edited in place by that name). Returned as it is, the failure ' +
      'surfaces minutes later as an edit of `undefined` against an API that has never heard ' +
      'of it, far from its cause (#31).'
    const { api } = recording({ notAMessage: true })

    await expect(api.post({ space: SPACE, thread: null, text: 'hello' }), why).rejects.toThrow(
      /name/i,
    )
  })

  it('lets an API failure through', async () => {
    const api = new HttpChatApi({
      send: () => Promise.reject(new Error('403 permission denied')),
      download: () => Promise.reject(new Error('no download in this test')),
    })

    await expect(api.post({ space: SPACE, thread: null, text: 'hi' })).rejects.toThrow(/403/)
  })
})

describe('the button that takes Overflow', () => {
  it('goes out as a card action carrying the Task id', async () => {
    const { api, last } = recording()

    await api.post({
      space: SPACE,
      thread: null,
      text: 'The shared Claude quota is spent.',
      actions: [
        {
          label: 'Run it on metered billing',
          action: 'takeOverflow',
          parameters: { taskId: 'task-7' },
        },
      ],
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

  it('keeps the text alongside the card', async () => {
    const { api, last } = recording()

    await api.post({
      space: SPACE,
      thread: null,
      text: 'The shared Claude quota is spent.',
      actions: [{ label: 'Run it', action: 'takeOverflow', parameters: { taskId: 'task-7' } }],
    })

    expect(last()?.body).toMatchObject({ text: 'The shared Claude quota is spent.' })
  })
})

describe('the buttons that choose off a Menu', () => {
  it('puts every button of a Menu in one list', async () => {
    const { api, last } = recording()

    await api.post({
      space: SPACE,
      thread: null,
      text: 'This conversation is on sonnet (claude-sonnet-5).',
      actions: ['fable', 'opus', 'sonnet', 'haiku', 'default'].map((option) => ({
        label: option,
        action: 'choose',
        parameters: { chooses: 'model', option },
      })),
    })

    const [widget] = buttonWidgetsOf(last()?.body)
    expect(widget?.buttonList.buttons.map((button) => button.text)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'default',
    ])
    expect(widget?.buttonList.buttons[0]?.onClick.action).toEqual({
      function: 'choose',
      parameters: [
        { key: 'chooses', value: 'model' },
        { key: 'option', value: 'fable' },
      ],
    })
  })

  it('sends no card where there is nothing to press', async () => {
    const { api, last } = recording()

    await api.post({ space: SPACE, thread: null, text: 'hello' })

    expect(last()?.body).not.toHaveProperty('cardsV2')
  })
})

describe('editing a message', () => {
  it('replaces the text of a message roma posted, by its resource name [fence:gchat-edit-names-the-field]', async () => {
    const why =
      'An edit carries `updateMask=text`, or Chat is not told which field is replaced ' +
      '(ADR-0010). An acknowledgement that quietly stopped updating is indistinguishable from ' +
      'a Task that died, which is the one thing that message exists to rule out (#31).'
    const { api, last } = recording({})

    await api.edit(POSTED, 'Working…')

    expect(last(), why).toEqual({
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

interface ButtonWidget {
  readonly buttonList: {
    readonly buttons: readonly {
      readonly text: string
      readonly onClick: { readonly action: unknown }
    }[]
  }
}

function buttonWidgetsOf(body: Readonly<Record<string, unknown>> | undefined): ButtonWidget[] {
  const cards = body?.['cardsV2'] as
    readonly { card: { sections: readonly { widgets: ButtonWidget[] }[] } }[] | undefined
  return cards?.[0]?.card.sections[0]?.widgets ?? []
}
