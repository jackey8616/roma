import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Credential } from '../../build-env.js'
import { cavemanRuleset } from '../../caveman.js'
import { PINNED_MODEL } from '../../claude-session.js'
import { bind, serve, type IngressLogRecord, type Serving } from '../../serve.js'
import { sessionIdFor } from '../../session-id.js'
import type { ClaudeEvent } from '../../stream-events.js'
import type { DiscordLogRecord } from './binding.js'
import { DiscordAdapter } from './discord-adapter.js'
import { GatewayTransport, RECONNECT_FLOOR_MS } from './gateway-transport.js'
import { HttpDiscordApi } from './http-discord-api.js'
import { flush } from '../../../test/support/fake-claude.js'
import { FakeGatewayNetwork } from '../../../test/support/fake-gateway.js'
import { FakeMinter, fakeShims } from '../../../test/support/fake-minter.js'
import { githubReach } from '../../github/reach.js'
import { noCloudReach } from '../../cloud/reach.js'
import { noDocumentReach } from '../../documents/reach.js'
import { romaFixture, teardownRoma, type RomaFixture } from '../../../test/support/roma-fixture.js'
import { BLOCKED_WITH_OVERAGE, feed, kindOf, OK } from '../../../test/support/recorded-stream.js'

const TOKEN = 'a-bot-token'
const GATEWAY = 'wss://gateway.example/?v=10&encoding=json'
const API = 'https://discord.example/api/v10'

const ROMA = '100000000000000001'
const CALLER = '200000000000000002'
const GUILD = '300000000000000004'
const CHANNEL = '400000000000000005'
const MESSAGE = '700000000000000009'
const CARD = '700000000000000017'
const INTERACTION = '900000000000000018'

const INSTALLATION = { account: 'a-team', repositories: ['a-team/roma'] }

const OAUTH: Credential = { kind: 'shared-window', oauthToken: 'oauth-token' }
const METERED: Credential = { kind: 'overflow', apiKey: 'metered-key' }

const UNMEASURED = 'claude-something-nobody-measured'

interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly body: Record<string, unknown>
}

const HELLO = { op: 10, d: { heartbeat_interval: 41_250 } }

const OP_RESUME = 6

const READY = {
  op: 0,
  s: 1,
  t: 'READY',
  d: {
    session_id: 'session-one',
    resume_gateway_url: GATEWAY,
    user: { id: ROMA, username: 'roma' },
  },
}

const GUILD_CREATE = {
  op: 0,
  s: 2,
  t: 'GUILD_CREATE',
  d: { id: GUILD, channels: [{ id: CHANNEL, type: 0 }], threads: [] },
}

function dispatch(name: string, payload: unknown, sequence = 3): unknown {
  return { op: 0, s: sequence, t: name, d: payload }
}

function mentioned(text: string, { id = MESSAGE, channel = CHANNEL } = {}): unknown {
  return dispatch('MESSAGE_CREATE', {
    id,
    channel_id: channel,
    guild_id: GUILD,
    author: { id: CALLER, username: 'ada', global_name: 'Ada', bot: false },
    content: `<@${ROMA}> ${text}`,
    mentions: [{ id: ROMA, username: 'roma' }],
    attachments: [],
  })
}

function inThread(text: string, id: string): unknown {
  return mentioned(text, { id, channel: MESSAGE })
}

function pressing(customId: string, id = INTERACTION): unknown {
  return dispatch('INTERACTION_CREATE', {
    id,
    token: 'an-interaction-token',
    type: 3,
    application_id: ROMA,
    channel_id: MESSAGE,
    guild_id: GUILD,
    member: { user: { id: CALLER, username: 'ada', global_name: 'Ada' } },
    data: { custom_id: customId, component_type: 2 },
    message: {
      id: CARD,
      channel_id: MESSAGE,
      guild_id: GUILD,
      author: { id: ROMA, username: 'roma', bot: true },
      content: 'You can choose…',
    },
  })
}

function reporting(model: string): readonly ClaudeEvent[] {
  return OK.map((event) => (kindOf(event) === 'system/init' ? { ...event, model } : event))
}

let running: Serving[] = []
let fixtures: RomaFixture[] = []

async function boot({ model = PINNED_MODEL }: { model?: string } = {}) {
  const fixture = romaFixture('discord-wiring')
  fixtures.push(fixture)

  const requests: RecordedRequest[] = []
  let posted = 0
  const api = new HttpDiscordApi({
    botToken: TOKEN,
    apiBase: API,
    fetch: (input, init) => {
      const url = String(input)
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      requests.push({ url, method: init?.method ?? 'GET', body })
      posted += 1
      const answer = url.endsWith('/threads')
        ? { id: url.split('/').at(-2) }
        : { id: `posted-${posted}` }
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }))
    },
  })

  const network = new FakeGatewayNetwork()
  const log: DiscordLogRecord[] = []
  const ingress: IngressLogRecord[] = []
  const minter = new FakeMinter({ installation: INSTALLATION })
  const shims = fakeShims()
  fixture.alsoRemove(shims.dir)
  const serving = serve({
    credential: OAUTH,
    reaches: { code: githubReach(minter), cloud: noCloudReach(), documents: noDocumentReach() },
    shims,
    overflow: { credential: METERED, monthlyCapUsd: 100 },
    channels: [
      bind(
        new DiscordAdapter({ api }),
        new GatewayTransport({
          token: TOKEN,
          url: GATEWAY,
          connect: network.connect,
          api,
          log: (record) => log.push(record),
          jitter: () => 1,
        }),
      ),
    ],
    ...(model === PINNED_MODEL ? {} : { model }),
    ...fixture.dirs,
    spawn: fixture.claude.spawn,
    log: (record) => {
      if ('deliveryId' in record) ingress.push(record)
    },
    selfCheckTimeoutMs: 1_000,
  })

  await fixture.answerProbe(model === PINNED_MODEL ? OK : reporting(model))
  const roma = await serving
  running.push(roma)

  return {
    claude: fixture.claude,
    requests,
    network,
    log,
    ingress,
    roma,
    async take(frame: unknown): Promise<void> {
      network.socket.push(frame)
      await flush()
    },
    procFor: (conversationKey = MESSAGE) => fixture.procFor(conversationKey),
  }
}

function said(requests: readonly RecordedRequest[]): string[] {
  return requests
    .filter(({ url, method }) => method === 'POST' && url.endsWith('/messages'))
    .map(({ body }) => String(body['content'] ?? ''))
}

interface PostedRow {
  readonly components: readonly { readonly label: string; readonly custom_id: string }[]
}

function buttonsOf(requests: readonly RecordedRequest[]) {
  const carrying = requests.filter(({ body }) => body['components'] !== undefined)
  const rows = (carrying.at(-1)?.body['components'] ?? []) as readonly PostedRow[]
  return rows.flatMap((row) => row.components)
}

function labelsOf(requests: readonly RecordedRequest[]): string[] {
  return buttonsOf(requests).map(({ label }) => label)
}

function customIdFor(requests: readonly RecordedRequest[], label: string): string {
  const button = buttonsOf(requests).find((candidate) => candidate.label === label)
  if (button === undefined) throw new Error(`no button labelled ${label}`)
  return button.custom_id
}

afterEach(async () => {
  await teardownRoma(
    running,
    fixtures.flatMap(({ roots }) => roots),
  )
  running = []
  fixtures = []
})

describe('a Discord message, all the way through and back', () => {
  it('opens the thread its key names and answers in it', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('summarise this'))
    await flush()
    feed(roma.procFor(), OK)
    await until(() => said(roma.requests).includes('ok'))

    expect(roma.requests).toContainEqual({
      url: `${API}/channels/${CHANNEL}/messages/${MESSAGE}/threads`,
      method: 'POST',
      body: { name: 'summarise this' },
    })
    expect(roma.requests).toContainEqual({
      url: `${API}/channels/${MESSAGE}/messages`,
      method: 'POST',
      body: {
        content: 'ok',
        message_reference: { message_id: MESSAGE, fail_if_not_exists: false },
        allowed_mentions: { parse: [], replied_user: true },
      },
    })
  })

  it('runs it on the Session its Conversation Key derives to', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('summarise this'))
    await flush()

    expect(roma.claude.lastSpawn.cwd).toContain(sessionIdFor(MESSAGE))
  })

  it('recognises a replay after a resume as the Delivery it is already doing', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('summarise this'))
    await flush()
    const running = roma.claude.processes.length
    const posted = roma.requests.length

    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    roma.network.socket.hangUp(1006)
    vi.advanceTimersByTime(RECONNECT_FLOOR_MS)
    vi.useRealTimers()
    roma.network.socket.push(HELLO)
    expect(roma.network.sockets).toHaveLength(2)
    expect(roma.network.socket.sentWith(OP_RESUME)).toHaveLength(1)
    await roma.take(mentioned('summarise this'))

    expect(roma.ingress).toContainEqual({ event: 'ingress-redelivered', deliveryId: MESSAGE })
    expect(roma.claude.processes).toHaveLength(running)
    expect(roma.requests).toHaveLength(posted)

    feed(roma.procFor(), OK)
    await until(() => said(roma.requests).includes('ok'))
    expect(said(roma.requests).filter((text) => text === 'ok')).toHaveLength(1)
  })
})

describe('a Menu, out as buttons and back as a press', () => {
  it('moves the Session onto the model whose button came back', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)
    const atBoot = roma.claude.processes.length

    await roma.take(mentioned('/model'))
    expect(labelsOf(roma.requests)).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'default'])
    expect(roma.claude.processes).toHaveLength(atBoot)

    await roma.take(pressing(customIdFor(roma.requests, 'opus')))

    await roma.take(inThread('hello', '700000000000000020'))
    await flush()

    expect(roma.claude.lastSpawn.args).toContain('claude-opus-5')
  })

  it('answers the press in the Conversation the button named', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('/effort'))
    expect(labelsOf(roma.requests)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'default'])

    await roma.take(pressing(customIdFor(roma.requests, 'xhigh')))

    expect(said(roma.requests).at(-1)).toContain('xhigh')
    expect(roma.requests.at(-1)?.url).toBe(`${API}/channels/${MESSAGE}/messages`)
  })

  it('acknowledges the press before it answers it, and never edits the card', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)
    await roma.take(mentioned('/model'))
    const before = roma.requests.length

    await roma.take(pressing(customIdFor(roma.requests, 'haiku')))

    const after = roma.requests.slice(before)
    expect(after[0]).toEqual({
      url: `${API}/interactions/${INTERACTION}/an-interaction-token/callback`,
      method: 'POST',
      body: { type: 6 },
    })
    expect(after.some(({ method }) => method === 'PATCH')).toBe(false)
  })

  it('draws no effort buttons on a model the Matrix says takes none', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('/model haiku'))
    await roma.take(inThread('/effort', '700000000000000021'))

    expect(said(roma.requests).at(-1)).toContain('takes none')
    expect(roma.requests.some(({ body }) => body['components'] !== undefined)).toBe(false)
  })

  it('draws them on a model the Matrix has never been read about', async () => {
    const roma = await boot({ model: UNMEASURED })
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('/effort'))

    expect(labelsOf(roma.requests)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'default'])
    expect(said(roma.requests).at(-1)).not.toContain('takes none')
  })

  it('moves the Session onto the hyphenated Caveman whose button came back', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('/caveman'))
    expect(labelsOf(roma.requests)).toEqual([
      'off',
      'lite',
      'full',
      'ultra',
      'wenyan-full',
      'default',
    ])

    await roma.take(pressing(customIdFor(roma.requests, 'wenyan-full')))
    expect(said(roma.requests).at(-1)).toContain('wenyan-full')

    await roma.take(inThread('hello', '700000000000000022'))
    await flush()

    const { args } = roma.claude.lastSpawn
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain(
      cavemanRuleset('wenyan-full'),
    )
  })
})

describe('the Overflow offer, out as a button and back as a press', () => {
  it('reruns the Task on metered billing when the button comes back', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('summarise this'))
    await flush()
    feed(roma.procFor(), BLOCKED_WITH_OVERAGE)
    await flush()

    expect(labelsOf(roma.requests)).toEqual(['Run it on metered billing'])

    await roma.take(pressing(customIdFor(roma.requests, 'Run it on metered billing')))
    await flush()
    feed(roma.procFor(), OK)
    await until(() => said(roma.requests).includes('ok'))

    expect(roma.claude.lastSpawn.env).toMatchObject({ ANTHROPIC_API_KEY: 'metered-key' })
    expect(said(roma.requests).at(-1)).toMatch(/metered billing/)
  })
})

async function until(condition: () => boolean, attempts = 500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return
    await flush()
  }
  throw new Error('gave up waiting')
}
