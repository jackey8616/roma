import { afterEach, describe, expect, it } from 'vitest'
import type { Credential } from '../../build-env.js'
import { cavemanRuleset } from '../../caveman.js'
import { bind, serve, type Serving } from '../../serve.js'
import { sessionIdFor } from '../../session-id.js'
import { GoogleChatAdapter } from './google-chat-adapter.js'
import { HttpChatApi, type ChatRequest } from './http-chat-api.js'
import { PubSubTransport } from './pubsub-transport.js'
import { flush } from '../../../test/support/fake-claude.js'
import {
  FakeCloudMinter,
  FakeDocumentMinter,
  FakeMinter,
  fakeShims,
} from '../../../test/support/fake-minter.js'
import { githubReach } from '../../github/reach.js'
import { cloudReach, noCloudReach } from '../../cloud/reach.js'
import { documentReach, noDocumentReach } from '../../documents/reach.js'
import type { Reach } from '../../reach.js'
import { askMinter } from '../../shim-client.js'
import { socketPathIn } from '../../shim-protocol.js'
import type { ShimLogRecord } from '../../shim-server.js'
import { FakePubSubMessage, FakeSubscription } from '../../../test/support/fake-pubsub.js'
import { romaFixture, teardownRoma, type RomaFixture } from '../../../test/support/roma-fixture.js'
import { BLOCKED_WITH_OVERAGE, feed, OK } from '../../../test/support/recorded-stream.js'

const SPACE = 'spaces/AAAA'
const THREAD = `${SPACE}/threads/thread-1`
const SENDER = 'users/17'
const TO = `<${SENDER}> `

const INSTALLATION = { account: 'a-team', repositories: ['a-team/roma', 'a-team/infra'] }

const OAUTH: Credential = { kind: 'shared-window', oauthToken: 'oauth-token' }
const METERED: Credential = { kind: 'overflow', apiKey: 'metered-key' }

function mentioned(text: string): Record<string, unknown> {
  return {
    type: 'MESSAGE',
    space: { name: SPACE, type: 'ROOM', spaceType: 'SPACE' },
    message: {
      name: `${SPACE}/messages/msg-1`,
      sender: { name: SENDER, displayName: 'Ada', type: 'HUMAN' },
      text: `@roma ${text}`,
      argumentText: ` ${text}`,
      thread: { name: THREAD },
    },
  }
}

let running: Serving[] = []
let fixtures: RomaFixture[] = []

async function boot({
  cloud,
  documents,
}: { cloud?: Reach<'cloud'>; documents?: Reach<'documents'> } = {}) {
  const fixture = romaFixture('wiring')
  fixtures.push(fixture)

  const requests: ChatRequest[] = []
  let posted = 0
  const api = new HttpChatApi({
    send: (request) => {
      requests.push(request)
      posted += 1
      return Promise.resolve({ name: `${SPACE}/messages/posted-${posted}` })
    },
    download: () => Promise.reject(new Error('no download in this test')),
  })

  const subscription = new FakeSubscription()
  const log: ShimLogRecord[] = []
  const minter = new FakeMinter({ installation: INSTALLATION })
  const shims = fakeShims()
  fixture.alsoRemove(shims.dir)
  const serving = serve({
    credential: OAUTH,
    reaches: {
      code: githubReach(minter),
      cloud: cloud ?? noCloudReach(),
      documents: documents ?? noDocumentReach(),
    },
    shims,
    overflow: { credential: METERED, monthlyCapUsd: 100 },
    channels: [
      bind(new GoogleChatAdapter({ api }), new PubSubTransport({ subscription, log: () => {} })),
    ],
    ...fixture.dirs,
    spawn: fixture.claude.spawn,
    log: (record) => log.push(record as ShimLogRecord),
    selfCheckTimeoutMs: 1_000,
  })

  await fixture.answerProbe()
  const roma = await serving
  running.push(roma)

  return {
    claude: fixture.claude,
    requests,
    subscription,
    minter,
    shims,
    log,
    roma,
    texts: () =>
      requests.filter(({ method }) => method === 'POST').map(({ body }) => body['text'] as string),
    procFor: (conversationKey = THREAD) => fixture.procFor(conversationKey),
  }
}

afterEach(async () => {
  await teardownRoma(
    running,
    fixtures.flatMap(({ roots }) => roots),
  )
  running = []
  fixtures = []
})

describe('a Chat message, all the way through and back', () => {
  it('answers in the thread it was asked in, and finishes with the message', async () => {
    const roma = await boot()

    const message = roma.subscription.publishJson(mentioned('summarise this'), 'msg-1')
    await flush()
    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    expect(roma.requests).toContainEqual({
      method: 'POST',
      url: expect.stringContaining(
        `${SPACE}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`,
      ),
      body: { text: `${TO}ok`, thread: { name: THREAD } },
    })
    expect(message.settlements).toEqual(['ack'])
  })

  it('runs it on the Session its thread derives to', async () => {
    const roma = await boot()

    const message = roma.subscription.publishJson(mentioned('summarise this'), 'msg-1')
    await flush()
    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    expect(roma.claude.lastSpawn.cwd).toContain(sessionIdFor(THREAD))
  })

  it('posts the acknowledgement once and the result as a message of its own', async () => {
    const roma = await boot()

    const message = roma.subscription.publishJson(mentioned('summarise this'), 'msg-1')
    await flush()
    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    const texts = roma.texts()
    expect(texts).toHaveLength(3)
    expect(texts.at(0)).toMatch(/This conversation is on /)
    expect(texts.at(-1)).toBe(`${TO}ok`)
    expect(texts.at(1)).not.toBe(`${TO}ok`)
  })

  it('never answers another app', async () => {
    const roma = await boot()

    const event = mentioned('summarise this')
    const fromAnApp = {
      ...event,
      message: {
        ...(event['message'] as Record<string, unknown>),
        sender: { name: 'users/99', type: 'BOT' },
      },
    }
    const message = roma.subscription.publishJson(fromAnApp, 'msg-1')
    await until(() => message.settlements.length > 0)

    expect(message.settlements).toEqual(['ack'])
    expect(roma.requests).toEqual([])
    expect(roma.claude.spawns).toHaveLength(1)
  })
})

describe('the Overflow offer, out on a card and back on a click', () => {
  it('reruns the Task on metered billing when the button comes back', async () => {
    const roma = await boot()

    const message = roma.subscription.publishJson(mentioned('summarise this'), 'msg-1')
    await flush()
    feed(roma.procFor(), BLOCKED_WITH_OVERAGE)
    await flush()

    const offer = roma.requests.findLast(({ body }) => body['cardsV2'] !== undefined)
    const taskId = buttonTaskIdOf(offer)
    expect(taskId).toMatch(/\S/)

    roma.subscription.publishJson(
      {
        type: 'CARD_CLICKED',
        common: { invokedFunction: 'takeOverflow', parameters: { taskId } },
      },
      'msg-2',
    )
    await flush()
    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    expect(roma.claude.lastSpawn.env).toMatchObject({ ANTHROPIC_API_KEY: 'metered-key' })
    expect(roma.texts().at(-1)).toMatch(/metered billing/)
  })

  it('reads the older click shape too', async () => {
    const roma = await boot()

    const message = roma.subscription.publishJson(mentioned('summarise this'), 'msg-1')
    await flush()
    feed(roma.procFor(), BLOCKED_WITH_OVERAGE)
    await flush()

    const taskId = buttonTaskIdOf(
      roma.requests.findLast(({ body }) => body['cardsV2'] !== undefined),
    )
    roma.subscription.publishJson(
      {
        type: 'CARD_CLICKED',
        action: {
          actionMethodName: 'takeOverflow',
          parameters: [{ key: 'taskId', value: taskId }],
        },
      },
      'msg-2',
    )
    await flush()
    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    expect(roma.claude.lastSpawn.env).toMatchObject({ ANTHROPIC_API_KEY: 'metered-key' })
  })
})

describe('a Menu, out on a card and back on a press', () => {
  it('moves the Session onto the model whose button came back', async () => {
    const roma = await boot()
    const atBoot = roma.claude.processes.length

    roma.subscription.publishJson(mentioned('/model'), 'msg-1')
    await flush()

    const card = roma.requests.findLast(({ body }) => body['cardsV2'] !== undefined)
    expect(labelsOf(card)).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'default'])
    expect(roma.claude.processes).toHaveLength(atBoot)

    roma.subscription.publishJson(pressOf(card, 'opus'), 'msg-2')
    await flush()

    const message = roma.subscription.publishJson(mentioned('hello'), 'msg-3')
    await flush()
    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    expect(roma.claude.lastSpawn.args).toContain('claude-opus-5')
  })

  it('answers the press in the thread, addressed to whoever pressed', async () => {
    const roma = await boot()

    roma.subscription.publishJson(mentioned('/effort'), 'msg-1')
    await flush()
    const card = roma.requests.findLast(({ body }) => body['cardsV2'] !== undefined)
    expect(labelsOf(card)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'default'])

    roma.subscription.publishJson(pressOf(card, 'xhigh'), 'msg-2')
    await flush()

    expect(roma.texts().at(-1)).toContain(TO)
    expect(roma.texts().at(-1)).toContain('xhigh')
  })

  it('moves the Session onto the hyphenated Caveman whose button came back', async () => {
    const roma = await boot()

    roma.subscription.publishJson(mentioned('/caveman'), 'msg-1')
    await flush()

    const card = roma.requests.findLast(({ body }) => body['cardsV2'] !== undefined)
    expect(labelsOf(card)).toEqual(['off', 'lite', 'full', 'ultra', 'wenyan-full', 'default'])

    roma.subscription.publishJson(pressOf(card, 'wenyan-full'), 'msg-2')
    await flush()
    expect(roma.texts().at(-1)).toContain(TO)
    expect(roma.texts().at(-1)).toContain('wenyan-full')

    const message = roma.subscription.publishJson(mentioned('hello'), 'msg-3')
    await flush()
    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    const { args } = roma.claude.lastSpawn
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain(
      cavemanRuleset('wenyan-full'),
    )
  })
})

describe('a message that is not one', () => {
  it('finishes with bytes that are not JSON, and keeps serving', async () => {
    const roma = await boot()

    const rubbish = new FakePubSubMessage('msg-1', 'not json at all {')
    roma.subscription.publish(rubbish)
    await until(() => rubbish.settlements.length > 0)

    const message = roma.subscription.publishJson(mentioned('summarise this'), 'msg-2')
    await flush()
    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    expect(rubbish.settlements).toEqual(['ack'])
    expect(roma.texts()).toContain(`${TO}ok`)
  })
})

describe('reaching the code, out of the real parts', () => {
  it('gives a Session a socket it can actually get a credential from', async () => {
    const roma = await boot()
    const message = roma.subscription.publishJson(mentioned('have a look at roma'), 'msg-1')
    await flush()

    const sessionId = sessionIdFor(THREAD)
    const answer = await askMinter(roma.claude.lastSpawn.env['ROMA_MINTER_SOCKET'] ?? '', {
      session: sessionId,
      operation: 'get',
      path: 'a-team/roma.git',
    })

    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    expect(answer.token).toBe('token-1')
    const asked = roma.log.find((record) => record.event === 'credential')
    expect(asked).toMatchObject({ sessionId, path: 'a-team/roma.git' })
    expect(asked?.event === 'credential' ? asked.taskId : null).toMatch(/\S/)
  })

  it('tells the Session which repositories it reaches', async () => {
    const roma = await boot()
    roma.subscription.publishJson(mentioned('have a look at roma'), 'msg-1')
    await flush()

    const { args } = roma.claude.lastSpawn
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('a-team/infra')

    feed(roma.procFor(), OK)
  })

  it('tells the Session about the Cloud Reach, where the deployment has one', async () => {
    const roma = await boot({ cloud: cloudReach(new FakeCloudMinter()) })
    roma.subscription.publishJson(mentioned('what is in that bucket'), 'msg-1')
    await flush()

    const { args } = roma.claude.lastSpawn
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('roma-cloud-token')

    feed(roma.procFor(), OK)
  })

  it('tells the Session about the Document Reach, where the deployment has one', async () => {
    const roma = await boot({ documents: documentReach(new FakeDocumentMinter()) })
    roma.subscription.publishJson(mentioned('write that up for us'), 'msg-1')
    await flush()

    const { args } = roma.claude.lastSpawn
    const announced = args[args.indexOf('--append-system-prompt') + 1] ?? ''
    expect(announced).toContain('roma-document-token')
    expect(announced).toContain('FOLDER_ID')

    feed(roma.procFor(), OK)
  })
})

function buttonTaskIdOf(request: ChatRequest | undefined): string {
  const cards = request?.body['cardsV2'] as
    | [
        {
          card: {
            sections: [
              {
                widgets: [
                  {
                    buttonList: {
                      buttons: [
                        { onClick: { action: { parameters: { key: string; value: string }[] } } },
                      ]
                    }
                  },
                ]
              },
            ]
          }
        },
      ]
    | undefined
  const parameters =
    cards?.[0].card.sections[0].widgets[0].buttonList.buttons[0].onClick.action.parameters
  const taskId = parameters?.find(({ key }) => key === 'taskId')?.value
  if (taskId === undefined) throw new Error('no Overflow button was posted')
  return taskId
}

async function until(condition: () => boolean, attempts = 500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return
    await flush()
  }
  throw new Error('gave up waiting')
}

interface PostedCard {
  readonly card: {
    readonly sections: readonly {
      readonly widgets: readonly {
        readonly buttonList: {
          readonly buttons: readonly {
            readonly text: string
            readonly onClick: {
              readonly action: { readonly parameters: readonly { key: string; value: string }[] }
            }
          }[]
        }
      }[]
    }[]
  }
}

function buttonsOf(request: ChatRequest | undefined) {
  const cards = request?.body['cardsV2'] as readonly PostedCard[] | undefined
  const buttons = cards?.[0]?.card.sections[0]?.widgets[0]?.buttonList.buttons
  if (buttons === undefined) throw new Error('no card with buttons was posted')
  return buttons
}

function labelsOf(request: ChatRequest | undefined): string[] {
  return buttonsOf(request).map(({ text }) => text)
}

function pressOf(request: ChatRequest | undefined, label: string): Record<string, unknown> {
  const button = buttonsOf(request).find(({ text }) => text === label)
  if (button === undefined) throw new Error(`no button labelled ${label}`)
  const parameters = Object.fromEntries(
    button.onClick.action.parameters.map(({ key, value }) => [key, value]),
  )
  return {
    type: 'CARD_CLICKED',
    user: { name: SENDER, displayName: 'Ada', type: 'HUMAN' },
    space: { name: SPACE, type: 'ROOM', spaceType: 'SPACE' },
    message: {
      name: `${SPACE}/messages/msg-card`,
      sender: { name: 'users/roma', displayName: 'roma', type: 'BOT' },
      thread: { name: THREAD },
    },
    common: { invokedFunction: 'choose', parameters },
  }
}
