import { afterEach, describe, expect, it } from 'vitest'
import type { Credential } from '../../build-env.js'
import { serve, type Serving } from '../../serve.js'
import { sessionIdFor } from '../../session-id.js'
import { GoogleChatAdapter } from './google-chat-adapter.js'
import { HttpChatApi, type ChatRequest } from './http-chat-api.js'
import { PubSubTransport } from './pubsub-transport.js'
import { flush } from '../../../test/support/fake-claude.js'
import { fakeMinting, FakeMinter } from '../../../test/support/fake-minter.js'
import { announce } from '../../github/announce.js'
import { askMinter } from '../../shim-client.js'
import { socketPathIn } from '../../shim-protocol.js'
import type { ShimLogRecord } from '../../shim-server.js'
import { FakePubSubMessage, FakeSubscription } from '../../../test/support/fake-pubsub.js'
import { romaFixture, teardownRoma, type RomaFixture } from '../../../test/support/roma-fixture.js'
import { BLOCKED_WITH_OVERAGE, feed, OK } from '../../../test/support/recorded-stream.js'

// The one test where roma is assembled out of its real parts: a Pub/Sub message
// goes in, `PubSubTransport` decodes it, `GoogleChatAdapter` reads it, the Core
// runs it, and `HttpChatApi` turns the answer into the request Google would have
// received. Only two things are doubles, and they are the two nothing here can
// have: Claude Code (the recorded stream) and the network on either side.
//
// It exists because every other test in this repo proves one of these in
// isolation, and the failure they cannot see is the one at the joins — a
// Transport emitting events the Adapter cannot read produces a roma that runs
// perfectly and answers nobody. `serve`'s type parameter catches that at compile
// time; this catches the rest of it.
//
// The Chat event below is still **written from Google's documentation, not
// captured**. Nothing in this repo can capture one — see ADR-0004, which is
// explicit that the payload's fields are the thing a real Workspace closes.

const SPACE = 'spaces/AAAA'
const THREAD = `${SPACE}/threads/thread-1`
const SENDER = 'users/17'

const INSTALLATION = { account: 'a-team', repositories: ['a-team/roma', 'a-team/infra'] }

const OAUTH: Credential = { kind: 'shared-window', oauthToken: 'oauth-token' }
const METERED: Credential = { kind: 'overflow', apiKey: 'metered-key' }

/** A message in a space, addressed to roma, as Chat publishes one. */
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

async function boot() {
  const fixture = romaFixture('wiring')
  fixtures.push(fixture)

  // Chat with the network taken out, and nothing else taken out: the requests
  // recorded here are the ones Google would have been sent.
  const requests: ChatRequest[] = []
  let posted = 0
  const api = new HttpChatApi({
    send: (request) => {
      requests.push(request)
      posted += 1
      return Promise.resolve({ name: `${SPACE}/messages/posted-${posted}` })
    },
  })

  const subscription = new FakeSubscription()
  const log: ShimLogRecord[] = []
  // The real announcement over a Minter with no App behind it: what a Session is
  // told it can reach is assembled here out of the same two parts production
  // uses, and only the forge itself is a double.
  const minter = new FakeMinter({ installation: INSTALLATION })
  const minting = fakeMinting({ minter, announce })
  fixture.alsoRemove(minting.shimDir)
  const serving = serve({
    credential: OAUTH,
    minting,
    overflow: { credential: METERED, monthlyCapUsd: 100 },
    channel: new GoogleChatAdapter({ api }),
    transport: new PubSubTransport({ subscription, log: () => {} }),
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
    minting,
    log,
    roma,
    /** Everything roma posted into Chat, in order. */
    texts: () =>
      requests
        .filter(({ method }) => method === 'POST')
        .map(({ body }) => body['text'] as string),
    procFor: (conversationKey = THREAD) => fixture.procFor(conversationKey),
  }
}

afterEach(async () => {
  await teardownRoma(running, fixtures.flatMap(({ roots }) => roots))
  running = []
  fixtures = []
})

describe('a Chat message, all the way through and back', () => {
  // The first acceptance criterion of #13, asserted against the real parts:
  // "messages pulled from the subscription reach the Core and produce a reply on
  // the Channel".
  it('answers in the thread it was asked in, and finishes with the message', async () => {
    const roma = await boot()

    const message = roma.subscription.publishJson(mentioned('summarise this'), 'msg-1')
    await flush()
    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    // The answer, as its own message in the caller's thread — with the option
    // that establishes the thread, which is the only way an app gets one.
    expect(roma.requests).toContainEqual({
      method: 'POST',
      url: expect.stringContaining(
        `${SPACE}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`,
      ),
      body: { text: 'ok', thread: { name: THREAD } },
    })
    expect(message.settlements).toEqual(['ack'])
  })

  // The Session is derived from the Conversation Key the Adapter minted out of
  // the event, with nothing stored in between. Getting this wrong is how every
  // message in a space would share one context, or each get its own.
  it('runs it on the Session its thread derives to', async () => {
    const roma = await boot()

    const message = roma.subscription.publishJson(mentioned('summarise this'), 'msg-1')
    await flush()
    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    expect(roma.claude.lastSpawn.cwd).toContain(sessionIdFor(THREAD))
  })

  // ADR-0003's unconditional rule, through the real parts: the result is its own
  // message, never the acknowledgement edited one last time. The acknowledgement
  // is the one before it, posted once — a Turn this short never gets a second
  // update past the throttle, so an edit is not what this can assert.
  it('posts the acknowledgement once and the result as a message of its own', async () => {
    const roma = await boot()

    const message = roma.subscription.publishJson(mentioned('summarise this'), 'msg-1')
    await flush()
    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    const texts = roma.texts()
    expect(texts).toHaveLength(2)
    expect(texts.at(-1)).toBe('ok')
    expect(texts.at(0)).not.toBe('ok')
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
    // Only the self-check's probe. No Session was ever asked for.
    expect(roma.claude.spawns).toHaveLength(1)
  })
})

describe('the Overflow offer, out on a card and back on a click', () => {
  // The whole round trip through the real parts, and the one thing no other test
  // covers: the Task id goes out inside a `cardsV2` payload and comes back
  // inside a click event, through two files that have to agree about a shape
  // neither of them owns.
  it('reruns the Task on metered billing when the button comes back', async () => {
    const roma = await boot()

    const message = roma.subscription.publishJson(mentioned('summarise this'), 'msg-1')
    await flush()
    feed(roma.procFor(), BLOCKED_WITH_OVERAGE)
    await flush()

    // The offer, as a button on the message that reports the block.
    const offer = roma.requests.findLast(({ body }) => body['cardsV2'] !== undefined)
    const taskId = buttonTaskIdOf(offer)
    expect(taskId).toMatch(/\S/)

    // The click, in the shape Chat's current interaction event uses.
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
    // What it cost is shown, which is ADR-0002's requirement of a metered reply.
    expect(roma.texts().at(-1)).toMatch(/metered billing/)
  })

  // Chat has two parameter shapes and which one arrives depends on how the event
  // was delivered — a fact `chat-events.ts` reads both ways for, and one nothing
  // in this repo can verify against a real Workspace. Both are exercised so that
  // dropping either would fail here rather than in production, silently, for
  // half the deliveries.
  it('reads the older click shape too', async () => {
    const roma = await boot()

    const message = roma.subscription.publishJson(mentioned('summarise this'), 'msg-1')
    await flush()
    feed(roma.procFor(), BLOCKED_WITH_OVERAGE)
    await flush()

    const taskId = buttonTaskIdOf(roma.requests.findLast(({ body }) => body['cardsV2'] !== undefined))
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
    expect(roma.texts()).toContain('ok')
  })
})

describe('reaching the code, out of the real parts', () => {
  // The whole credential path, assembled: a Session is spawned with a socket
  // path and a Session id, roma is listening on that socket, and what comes back
  // is a token. Only the forge is a double — the Minter is fake and everything
  // between it and the process environment is the real thing.
  it('gives a Session a socket it can actually get a credential from', async () => {
    const roma = await boot()
    const message = roma.subscription.publishJson(mentioned('have a look at roma'), 'msg-1')
    await flush()

    // Mid-Turn, which is when a `git clone` inside the agent's shell would ask.
    const sessionId = sessionIdFor(THREAD)
    const answer = await askMinter(roma.claude.lastSpawn.env['ROMA_MINTER_SOCKET'] ?? '', {
      session: sessionId,
      operation: 'get',
      path: 'a-team/roma.git',
    })

    feed(roma.procFor(), OK)
    await until(() => message.settlements.length > 0)

    expect(answer.token).toBe('token-1')
    // Attribution by Session, resolved to a Task through the Task Queue, which
    // is the only thing that knows the answer — and it is a real Task id here
    // rather than a null, because the Turn was in flight when the tool asked.
    const asked = roma.log.find((record) => record.event === 'credential')
    expect(asked).toMatchObject({ sessionId, path: 'a-team/roma.git' })
    expect(asked?.event === 'credential' ? asked.taskId : null).toMatch(/\S/)
  })

  // Story 3 and 4, through the real announcement: a Session that is not told it
  // has credentials refuses work it is perfectly able to do.
  it('tells the Session which repositories it reaches', async () => {
    const roma = await boot()
    roma.subscription.publishJson(mentioned('have a look at roma'), 'msg-1')
    await flush()

    const { args } = roma.claude.lastSpawn
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('a-team/infra')

    feed(roma.procFor(), OK)
  })
})

/** The Task id off the button in a card roma posted. */
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
  const parameters = cards?.[0].card.sections[0].widgets[0].buttonList.buttons[0].onClick.action
    .parameters
  const taskId = parameters?.find(({ key }) => key === 'taskId')?.value
  if (taskId === undefined) throw new Error('no Overflow button was posted')
  return taskId
}

/**
 * Wait for something the subscriber does detached from the call that started it.
 *
 * A Pub/Sub message handler is not awaited by whatever published the message, so
 * there is no promise for a test to hold. Polling the observable result is the
 * honest way to wait for one.
 */
async function until(condition: () => boolean, attempts = 500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return
    await flush()
  }
  throw new Error('gave up waiting')
}
