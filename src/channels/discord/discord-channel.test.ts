import { sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IngressMessage, OutboundInstruction } from '../../channel-adapter.js'
import { CAVEMAN_NAMES, OFF_MENU_WENYAN } from '../../caveman.js'
import { commandSpellings, readCommand } from '../../commands.js'
import { EFFORT_NAMES } from '../../effort-menu.js'
import { MENU_NAMES } from '../../model-menu.js'
import { sessionIdFor } from '../../session-id.js'
import type { Delivery } from '../../transport.js'
import type { DiscordLogRecord } from './binding.js'
import {
  ATTEMPTS,
  DiscordAdapter,
  REMEMBERED,
  RETRY_CEILING_MS,
  RETRY_FLOOR_MS,
} from './discord-adapter.js'
import { DiscordRefusal, MAX_BUTTONS, type DiscordButton } from './discord-api.js'
import {
  chooseId,
  MAX_CUSTOM_ID,
  overflowId,
  readPress,
  type DiscordEvent,
  type DiscordMessage,
} from './discord-events.js'
import {
  GatewayTransport,
  INTENTS,
  RECONNECT_CEILING_MS,
  RECONNECT_FLOOR_MS,
} from './gateway-transport.js'
import { MAX_TEXT, OVERFLOW_BUTTON } from './render.js'
import { OVERFLOW_BUTTON as CHAT_OVERFLOW_BUTTON } from '../google-chat/render.js'
import { FakeGatewayNetwork } from '../../../test/support/fake-gateway.js'
import { recordedStream } from '../../../test/support/recorded-stream.js'
import {
  RecordingDiscordApi,
  type DiscordCall,
} from '../../../test/support/recording-discord-api.js'
import { sources } from '../../../test/support/sources.js'

const TOKEN = 'a-bot-token'
const GATEWAY = 'wss://gateway.example/?v=10&encoding=json'
const RESUME_GATEWAY = 'wss://resume.example/?v=10&encoding=json'
const HEARTBEAT_INTERVAL = 41_250

const ROMA = '100000000000000001'
const CALLER = '200000000000000002'
const SOMEBODY_ELSE = '200000000000000003'
const GUILD = '300000000000000004'
const CHANNEL = '400000000000000005'
const THREAD = '500000000000000006'
const ARCHIVED = '500000000000000007'
const FORUM = '400000000000000016'
const DM = '600000000000000008'
const MESSAGE = '700000000000000009'
const NEXT_MESSAGE = '700000000000000019'
const QUOTED = '700000000000000010'
const CARD = '700000000000000017'
const INTERACTION = '900000000000000018'
const INTERACTION_TOKEN = 'an-interaction-token'

const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6

const HELLO = { op: 10, d: { heartbeat_interval: HEARTBEAT_INTERVAL } }

function ready(sequence = 1): unknown {
  return {
    op: 0,
    s: sequence,
    t: 'READY',
    d: {
      session_id: 'session-one',
      resume_gateway_url: RESUME_GATEWAY,
      user: { id: ROMA, username: 'roma' },
    },
  }
}

function guildCreate(channels: readonly string[] = [CHANNEL], sequence = 2): unknown {
  return {
    op: 0,
    s: sequence,
    t: 'GUILD_CREATE',
    d: {
      id: GUILD,
      channels: channels.map((id) => ({ id, type: 0 })),
      threads: [{ id: THREAD, type: 11 }],
    },
  }
}

function dispatch(name: string, payload: unknown, sequence = 3): unknown {
  return { op: 0, s: sequence, t: name, d: payload }
}

function addressed(overrides: Record<string, unknown> = {}): DiscordMessage {
  return {
    id: MESSAGE,
    channel_id: CHANNEL,
    guild_id: GUILD,
    author: { id: CALLER, username: 'ada', global_name: 'Ada', bot: false },
    content: `<@${ROMA}> summarise this`,
    mentions: [{ id: ROMA, username: 'roma' }],
    attachments: [],
    ...overrides,
  }
}

function inDm(overrides: Record<string, unknown> = {}): DiscordMessage {
  return {
    id: MESSAGE,
    channel_id: DM,
    author: { id: CALLER, username: 'ada', global_name: 'Ada' },
    content: 'hello',
    attachments: [],
    ...overrides,
  }
}

function card(overrides: Record<string, unknown> = {}): DiscordMessage {
  return {
    id: CARD,
    channel_id: MESSAGE,
    guild_id: GUILD,
    author: { id: ROMA, username: 'roma', bot: true },
    content: 'You can choose: fable, opus, sonnet, haiku, default.',
    ...overrides,
  }
}

function press(customId: string, overrides: Record<string, unknown> = {}): unknown {
  return dispatch('INTERACTION_CREATE', {
    id: INTERACTION,
    token: INTERACTION_TOKEN,
    type: 3,
    application_id: ROMA,
    channel_id: MESSAGE,
    guild_id: GUILD,
    member: { user: { id: CALLER, username: 'ada', global_name: 'Ada' } },
    data: { custom_id: customId, component_type: 2 },
    message: card(),
    ...overrides,
  })
}

const ATTACHED = {
  id: '800000000000000011',
  filename: 'screenshot.png',
  content_type: 'image/png',
  url: 'https://cdn.example/attachments/screenshot.png?ex=deadbeef',
}

async function listening() {
  const api = new RecordingDiscordApi()
  const network = new FakeGatewayNetwork()
  const log: DiscordLogRecord[] = []
  const waits: number[] = []
  const adapter = new DiscordAdapter({
    api,
    log: (record) => log.push(record),
    wait: (ms) => {
      waits.push(ms)
      return Promise.resolve()
    },
  })
  const transport = new GatewayTransport({
    token: TOKEN,
    url: GATEWAY,
    connect: network.connect,
    api,
    log: (record) => log.push(record),
    jitter: () => 1,
  })

  const deliveries: Delivery<DiscordEvent>[] = []
  const read: IngressMessage[] = []
  const saidBefore: DiscordCall[][] = []
  await transport.receive(async (delivery) => {
    saidBefore.push([...api.calls])
    deliveries.push(delivery)
    const message = adapter.toIngress(delivery.event)
    if (message !== null) read.push(message)
    await delivery.ack()
  })

  return {
    api,
    network,
    log,
    waits,
    adapter,
    transport,
    deliveries,
    read,
    saidBefore,
    get buttons(): readonly DiscordButton[] {
      return api.messages.at(-1)?.posted.buttons ?? []
    },
    get last(): IngressMessage | null {
      return read.at(-1) ?? null
    },
    async take(frame: unknown): Promise<void> {
      network.socket.push(frame)
      await flushed()
    },
  }
}

async function connected(channels: readonly string[] = [CHANNEL]) {
  const channel = await listening()
  await channel.take(HELLO)
  await channel.take(ready())
  await channel.take(guildCreate(channels))
  return channel
}

async function messaged(message: DiscordMessage, channels: readonly string[] = [CHANNEL]) {
  const channel = await connected(channels)
  await channel.take(dispatch('MESSAGE_CREATE', message))
  return channel
}

type Outcome<T> = T extends unknown
  ? Omit<T, 'taskId' | 'conversationKey' | 'caller' | 'callerName'>
  : never

function to(
  conversationKey: string,
  outcome: Outcome<OutboundInstruction>,
  taskId = 'task-1',
  caller = CALLER,
  callerName: string | null = 'Ada',
): OutboundInstruction {
  return { ...outcome, taskId, conversationKey, caller, callerName }
}

function refusal(status: number, retryAfterMs: number | null = null): DiscordRefusal {
  return new DiscordRefusal(`Discord answered ${status}`, status, retryAfterMs)
}

function unopened(log: readonly DiscordLogRecord[]): readonly DiscordLogRecord[] {
  return log.filter(({ event }) => event === 'thread-unopened')
}

function choice(
  chooses: 'model' | 'effort' | 'caveman',
  options: readonly string[],
  text = `You can choose: ${options.join(', ')}.`,
): Outcome<OutboundInstruction> {
  return { kind: 'choice', text, chooses, options, refused: null }
}

function customIdFor(buttons: readonly DiscordButton[], label: string): string {
  const button = buttons.find((candidate) => candidate.label === label)
  if (button === undefined) throw new Error(`no button labelled ${label}`)
  return button.customId
}

function recordedAnswer(): string {
  const [finished] = recordedStream('generation-partial-messages')
    .turn(1)
    .filter((event) => event.type === 'result')
  return String(finished?.['result'] ?? '')
}

describe('which Conversation a Discord message belongs to', () => {
  it('is the channel, in a direct message', async () => {
    const channel = await messaged(inDm())

    expect(channel.last?.conversationKey).toBe(DM)
  })

  it('is the channel it arrived in, in a thread', async () => {
    const channel = await messaged(addressed({ channel_id: THREAD }))

    expect(channel.last?.conversationKey).toBe(THREAD)
  })

  it('is the message’s own id at the top level — the id the thread will take', async () => {
    const channel = await messaged(addressed())

    expect(channel.last?.conversationKey).toBe(MESSAGE)
  })

  it('reaches the same Session every time, for the same Conversation', async () => {
    const channel = await connected()

    await channel.take(dispatch('MESSAGE_CREATE', addressed({ id: '1', channel_id: THREAD })))
    await channel.take(dispatch('MESSAGE_CREATE', addressed({ id: '2', channel_id: THREAD })))

    const [first, second] = channel.read
    expect(first?.conversationKey).toBe(second?.conversationKey)
    expect(sessionIdFor(first?.conversationKey ?? '')).toBe(
      sessionIdFor(second?.conversationKey ?? ''),
    )
    expect(sessionIdFor(THREAD)).not.toBe(sessionIdFor(DM))
  })

  it('reads a thread archived out of both of the guild’s lists as a thread [fence:discord-key-against-channel-list]', async () => {
    const why =
      'A Conversation Key must be derived against the guild’s channel list, never its thread ' +
      'list (ADR-0029). `channels` is complete and `threads` holds only the active ones, so a ' +
      'thread archived for a day is in neither: read against the thread list it is taken for ' +
      'one of the guild’s channels, keyed on each message, and its Session splits (#191).'
    const channel = await messaged(addressed({ channel_id: ARCHIVED }))

    expect(channel.last?.conversationKey, why).toBe(ARCHIVED)
  })

  it('learns a channel made after it connected, and forgets a deleted one', async () => {
    const channel = await connected()
    const made = '400000000000000012'

    await channel.take(dispatch('CHANNEL_CREATE', { id: made, guild_id: GUILD, type: 0 }))
    await channel.take(dispatch('MESSAGE_CREATE', addressed({ id: '1', channel_id: made })))
    await channel.take(dispatch('CHANNEL_DELETE', { id: made, guild_id: GUILD, type: 0 }))
    await channel.take(dispatch('MESSAGE_CREATE', addressed({ id: '2', channel_id: made })))

    expect(channel.read.map(({ conversationKey }) => conversationKey)).toEqual(['1', made])
  })

  it('takes a thread announced on the socket back out of the channel list', async () => {
    const channel = await connected([CHANNEL, THREAD])

    await channel.take(dispatch('THREAD_CREATE', { id: THREAD, guild_id: GUILD, type: 11 }))
    await channel.take(dispatch('MESSAGE_CREATE', addressed({ channel_id: THREAD })))

    expect(channel.last?.conversationKey).toBe(THREAD)
  })
})

describe('every way the key can be wrong is the harmless direction', () => {
  it('gives a misread thread a Session per message, and mixes nobody', async () => {
    const channel = await connected([CHANNEL, ARCHIVED])

    await channel.take(
      dispatch(
        'MESSAGE_CREATE',
        addressed({ id: '1', channel_id: ARCHIVED, author: person(CALLER) }),
      ),
    )
    await channel.take(
      dispatch(
        'MESSAGE_CREATE',
        addressed({ id: '2', channel_id: ARCHIVED, author: person(SOMEBODY_ELSE) }),
      ),
    )

    const keys = channel.read.map(({ conversationKey }) => conversationKey)
    expect(keys).toEqual(['1', '2'])
    expect(sessionIdFor('1')).not.toBe(sessionIdFor('2'))
  })

  it('carries the channel the message arrived in, whatever the key says', async () => {
    const channel = await connected([CHANNEL, ARCHIVED])

    await channel.take(dispatch('MESSAGE_CREATE', addressed({ channel_id: ARCHIVED })))

    expect(channel.deliveries.at(-1)?.event.message['channel_id']).toBe(ARCHIVED)
    expect(channel.last?.conversationKey).toBe(MESSAGE)
  })
})

describe('what roma reads out of a message', () => {
  it('strips its own mention, so a Command survives as one [fence:discord-strips-only-its-own-mention]', async () => {
    const channel = await messaged(addressed({ content: `<@${ROMA}> /stop` }))

    expect(channel.last?.text, STRIPS_ITS_OWN).toBe('/stop')
    expect(readCommand(channel.last?.text ?? ''), STRIPS_ITS_OWN).toEqual({
      command: 'stop',
      argument: null,
    })
  })

  it('strips the older spelling of the same mention [fence:discord-strips-only-its-own-mention]', async () => {
    const channel = await messaged(addressed({ content: `<@!${ROMA}> /clear` }))

    expect(readCommand(channel.last?.text ?? ''), STRIPS_ITS_OWN).toEqual({
      command: 'clear',
      argument: null,
    })
  })

  it('leaves everybody else’s mention where it was [fence:discord-strips-only-its-own-mention]', async () => {
    const channel = await messaged(
      addressed({ content: `<@${ROMA}> ask <@${SOMEBODY_ELSE}> about the outage` }),
    )

    expect(channel.last?.text, STRIPS_ITS_OWN).toBe(`ask <@${SOMEBODY_ELSE}> about the outage`)
  })

  it('ignores another app, and says so rather than saying nothing [fence:discord-press-has-its-own-reader]', async () => {
    const channel = await messaged(addressed({ author: { id: SOMEBODY_ELSE, bot: true } }))

    expect(channel.read, OWN_READER).toEqual([])
    expect(channel.deliveries).toHaveLength(1)
  })

  it('ignores a message posted through a webhook', async () => {
    const channel = await messaged(addressed({ webhook_id: '900000000000000013' }))

    expect(channel.read).toEqual([])
  })

  it('ignores a guild message that did not address it', async () => {
    const channel = await messaged(addressed({ content: 'what did you all think?', mentions: [] }))

    expect(channel.read).toEqual([])
  })

  it('answers a message that names it in the mentions and not in the words [fence:discord-addressed-by-either-half]', async () => {
    const channel = await messaged(addressed({ content: 'and this one?' }))

    expect(channel.last?.text, EITHER_HALF).toBe('and this one?')
  })

  it('answers a message that names it in the words and carries no list [fence:discord-addressed-by-either-half]', async () => {
    const channel = await messaged(addressed({ mentions: undefined }))

    expect(channel.last?.text, EITHER_HALF).toBe('summarise this')
  })

  it('answers a direct message with no mention in it at all', async () => {
    const channel = await messaged(inDm())

    expect(channel.last?.text).toBe('hello')
  })

  it('reads a message with nothing in it as not a request', async () => {
    const channel = await messaged(addressed({ content: `<@${ROMA}>` }))

    expect(channel.read).toEqual([])
  })

  it('passes the author through as the Caller, with the display name beside it', async () => {
    const channel = await messaged(addressed())

    expect(channel.last).toMatchObject({ caller: CALLER, callerName: 'Ada' })
  })

  it('names a Caller by their username where Discord shows no other name', async () => {
    const channel = await messaged(addressed({ author: { id: CALLER, username: 'ada' } }))

    expect(channel.last?.callerName).toBe('ada')
  })
})

describe('what was sent alongside the message', () => {
  it('takes an attachment as an Enclosure, and fetches nothing until it is redeemed', async () => {
    const channel = await messaged(addressed({ attachments: [ATTACHED] }))
    channel.api.holdsAttachment(ATTACHED.url, 'the bytes')

    const enclosure = channel.last?.enclosures[0]
    expect(enclosure).toMatchObject({ name: 'screenshot.png', from: null })
    expect(channel.api.downloads).toEqual([])

    expect(new TextDecoder().decode(await enclosure?.redeem())).toBe('the bytes')
    expect(channel.api.downloads).toEqual([ATTACHED.url])
  })

  it('lets a redeem fail where the link has expired', async () => {
    const channel = await messaged(addressed({ attachments: [ATTACHED] }))

    await expect(channel.last?.enclosures[0]?.redeem()).rejects.toThrow(/no content/)
  })

  it('reads a message with an attachment and no words as a request', async () => {
    const channel = await messaged(inDm({ content: '', attachments: [ATTACHED] }))

    expect(channel.last).toMatchObject({ text: '', enclosures: [{ name: 'screenshot.png' }] })
  })
})

describe('a Quotation is completed before the Core sees it', () => {
  const replying = addressed({
    content: `<@${ROMA}> what do you think about this?`,
    message_reference: { message_id: QUOTED, channel_id: CHANNEL },
    referenced_message: { id: QUOTED, content: '', author: { id: SOMEBODY_ELSE } },
  })

  it('fetches the quoted message and hands over the words', async () => {
    const channel = await connected()
    channel.api.holds(CHANNEL, QUOTED, {
      id: QUOTED,
      content: 'the deploy failed at 3am',
      author: { id: SOMEBODY_ELSE, username: 'bob', global_name: 'Bob' },
    })

    await channel.take(dispatch('MESSAGE_CREATE', replying))

    expect(channel.api.fetched).toEqual([`${CHANNEL}/${QUOTED}`])
    expect(channel.last?.quotation).toEqual({ text: 'the deploy failed at 3am', author: 'Bob' })
  })

  it('hands over no Quotation where the fetch is refused, and says so', async () => {
    const channel = await messaged(replying)

    expect(channel.last?.quotation).toBeNull()
    expect(channel.last?.text).toBe('what do you think about this?')
    expect(channel.log).toContainEqual({ event: 'quote-unfetched', reason: expect.any(String) })
  })

  it('takes a forwarded passage from the snapshot, with no author at all', async () => {
    const channel = await messaged(
      addressed({
        message_reference: { type: 1, message_id: QUOTED, channel_id: '400000000000000014' },
        message_snapshots: [{ message: { content: 'read this thread', attachments: [] } }],
      }),
    )

    expect(channel.last?.quotation).toEqual({ text: 'read this thread', author: null })
    expect(channel.api.fetched).toEqual([])
  })

  it('reads a message that only quotes something as a request', async () => {
    const channel = await messaged(
      inDm({
        content: '',
        message_snapshots: [{ message: { content: 'the deploy failed at 3am' } }],
      }),
    )

    expect(channel.last).toMatchObject({
      text: '',
      quotation: { text: 'the deploy failed at 3am' },
    })
  })
})

describe('nothing is processed before the state that makes it readable', () => {
  it('holds a message that arrives before the guild’s channels, then reads it right', async () => {
    const channel = await listening()
    await channel.take(HELLO)
    await channel.take(ready())

    await channel.take(dispatch('MESSAGE_CREATE', addressed()))
    expect(channel.deliveries).toEqual([])
    expect(channel.log).toContainEqual({ event: 'gateway-held', guildId: GUILD })

    await channel.take(guildCreate())

    expect(channel.last?.conversationKey).toBe(MESSAGE)
  })

  it('holds a direct message only until it knows who it is', async () => {
    const channel = await listening()

    await channel.take(dispatch('MESSAGE_CREATE', inDm()))
    expect(channel.deliveries).toEqual([])

    await channel.take(HELLO)
    await channel.take(ready())

    expect(channel.last?.conversationKey).toBe(DM)
  })

  it('hands a press on without waiting for the guild’s channels [fence:discord-press-not-held]', async () => {
    const why =
      'A press must not be held for guild state (ADR-0029). It carries its Conversation Key on ' +
      'the button, so the channel list a key is otherwise derived from is nothing it needs — ' +
      'and the person has already been told their press arrived, so holding it leaves them ' +
      'waiting on an answer for state that changes nothing about it (#191).'
    const channel = await listening()
    await channel.take(HELLO)
    await channel.take(ready())

    await channel.take(press(chooseId('model', MESSAGE, 'opus')))

    expect(channel.last, why).toMatchObject({ conversationKey: MESSAGE, text: '/model opus' })
    expect(
      channel.log.map(({ event }) => event),
      why,
    ).not.toContain('gateway-held')
  })
})

describe('a delivery runs beside the socket rather than on it', () => {
  it('reads the next message while a Task from the last one is still running [fence:discord-deliver-is-detached]', async () => {
    const api = new RecordingDiscordApi()
    const network = new FakeGatewayNetwork()
    const transport = new GatewayTransport({
      token: TOKEN,
      url: GATEWAY,
      connect: network.connect,
      api,
      log: () => {},
      jitter: () => 1,
    })
    const arrived: string[] = []
    await transport.receive((delivery) => {
      arrived.push(delivery.id)
      return new Promise(() => {})
    })
    network.socket.push(HELLO)
    network.socket.push(ready())

    network.socket.push(dispatch('MESSAGE_CREATE', inDm({ id: 'first' })))
    await flushed()
    network.socket.push(dispatch('MESSAGE_CREATE', inDm({ id: 'second' })))
    await flushed()

    expect(arrived, DETACHED).toEqual(['first', 'second'])
  })

  it('keys a message on the guild as it stood when it arrived, not a round trip later [fence:discord-deliver-is-detached]', async () => {
    const channel = await connected()
    channel.api.holds(CHANNEL, QUOTED, { id: QUOTED, content: 'the deploy failed at 3am' })

    channel.network.socket.push(
      dispatch(
        'MESSAGE_CREATE',
        addressed({ message_reference: { message_id: QUOTED, channel_id: CHANNEL } }),
      ),
    )
    channel.network.socket.push(dispatch('CHANNEL_DELETE', { id: CHANNEL, guild_id: GUILD }))
    await flushed()

    expect(channel.last?.quotation).toMatchObject({ text: 'the deploy failed at 3am' })
    expect(channel.last?.conversationKey, DETACHED).toBe(MESSAGE)
  })
})

describe('the connection roma holds open', () => {
  it('identifies with the guild and message intents, and no privileged one [fence:discord-no-privileged-intent]', async () => {
    const channel = await listening()
    await channel.take(HELLO)

    const [identify] = channel.network.socket.sentWith(OP_IDENTIFY)
    expect(identify?.['d']).toMatchObject({ token: TOKEN, intents: INTENTS })
    expect(
      INTENTS & (1 << 15),
      'INTENTS asks for MESSAGE_CONTENT, the privileged intent roma refuses (ADR-0029)',
    ).toBe(0)
  })

  it('heartbeats on the interval Discord named, carrying the last event it saw', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await listening()
    await channel.take(HELLO)
    await channel.take(ready(7))

    expect(channel.network.socket.sentWith(OP_HEARTBEAT)).toEqual([])
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL)

    expect(channel.network.socket.sentWith(OP_HEARTBEAT)).toEqual([{ op: OP_HEARTBEAT, d: 7 }])

    await channel.take({ op: 11 })
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL)
    expect(channel.network.socket.sentWith(OP_HEARTBEAT)).toHaveLength(2)
  })

  it('gives up on a connection that stopped answering, and resumes [fence:discord-dead-socket-noticed]', async () => {
    const why =
      'roma must close a connection whose last heartbeat went unanswered (ADR-0029). The ' +
      'missing ACK is the only thing that tells a quiet socket from a dead one; unchecked, ' +
      'the dead socket stays open, delivers nothing, and roma looks healthy while it answers ' +
      'nobody (#191).'
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await listening()
    await channel.take(HELLO)
    await channel.take(ready())

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL)
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL)

    expect(channel.network.sockets[0]?.closedWith, why).toBe(4000)
    vi.advanceTimersByTime(RECONNECT_FLOOR_MS)
    expect(channel.network.sockets, why).toHaveLength(2)
  })

  it('backs off, doubling, up to a ceiling, while it cannot get back on [fence:discord-reconnect-backs-off]', async () => {
    const why =
      'roma must wait before reconnecting, doubling from RECONNECT_FLOOR_MS up to ' +
      'RECONNECT_CEILING_MS until a READY or RESUMED (ADR-0029). A loop that does not back off ' +
      'spends its way into the invalid-request limit DiscordRefusal describes, whose block is ' +
      'on the whole API rather than the connection — so the socket roma cannot get back on ' +
      'takes the REST API down with it (#191).'
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await listening()
    await channel.take(HELLO)

    let wait = RECONNECT_FLOOR_MS
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      channel.network.socket.hangUp(1006)
      vi.advanceTimersByTime(wait - 1)
      expect(channel.network.sockets, `${why} (attempt ${attempt}, too soon)`).toHaveLength(attempt)
      vi.advanceTimersByTime(1)
      expect(channel.network.sockets, `${why} (attempt ${attempt})`).toHaveLength(attempt + 1)
      wait = Math.min(wait * 2, RECONNECT_CEILING_MS)
    }
  })

  it('ignores a close from a connection it has already left behind [fence:discord-stale-close-ignored]', async () => {
    const why =
      '#closed must ignore a close from any socket but the current one (ADR-0029). A socket ' +
      'abandoned a second ago can answer its own close after the reconnection opened another; ' +
      'read as the current connection ending, it opens a second Gateway beside the live one ' +
      'and every message is delivered twice (#191).'
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await listening()
    await channel.take(HELLO)
    await channel.take(ready())

    const abandoned = channel.network.socket
    abandoned.hangUp(1006)
    vi.advanceTimersByTime(RECONNECT_FLOOR_MS)
    expect(channel.network.sockets).toHaveLength(2)

    abandoned.hangUp(1006)
    vi.advanceTimersByTime(RECONNECT_CEILING_MS)

    expect(channel.network.sockets, why).toHaveLength(2)
  })

  it('resumes where READY said to, naming the session and the last event', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await listening()
    await channel.take(HELLO)
    await channel.take(ready(4))

    channel.network.socket.hangUp(1006)
    expect(channel.log).toContainEqual({
      event: 'gateway-disconnected',
      code: 1006,
      resuming: true,
    })

    vi.advanceTimersByTime(RECONNECT_FLOOR_MS)
    expect(channel.network.socket.url).toBe(RESUME_GATEWAY)

    channel.network.socket.push(HELLO)
    expect(channel.network.socket.sentWith(OP_RESUME)[0]?.['d']).toEqual({
      token: TOKEN,
      session_id: 'session-one',
      seq: 4,
    })
    expect(channel.network.socket.sentWith(OP_IDENTIFY)).toEqual([])
  })

  it('names a replayed message the same both times [fence:discord-delivery-named-by-snowflake]', async () => {
    const why =
      'A Delivery must be named by the event’s own snowflake, never by anything minted in the ' +
      'Transport (ADR-0028). A resumed session replays what roma missed, and the id is the only ' +
      'thing that tells that replay from a second message saying the same words — minted ' +
      'locally, the replay is answered, and billed, twice (#191).'
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await connected()
    await channel.take(dispatch('MESSAGE_CREATE', addressed()))

    channel.network.socket.hangUp(1006)
    vi.advanceTimersByTime(RECONNECT_FLOOR_MS)
    channel.network.socket.push(HELLO)
    await channel.take(dispatch('MESSAGE_CREATE', addressed()))

    expect(
      channel.deliveries.map(({ id }) => id),
      why,
    ).toEqual([MESSAGE, MESSAGE])
  })

  it('settles a Delivery by saying nothing at all [fence:discord-settling-does-nothing]', async () => {
    const why =
      'A Gateway Delivery’s ack and nack must do nothing (ADR-0028). A socket has nowhere to hand ' +
      'a Delivery back to: a nack that closed to resume, or sent anything, would promise a ' +
      'redelivery that never comes — a resume replays what roma missed, never what it was handed — ' +
      'and an ack on a Gateway event is a sentence with no listener (#178, #191).'
    const channel = await messaged(addressed())
    const before = channel.network.socket.sent.length
    const delivery = channel.deliveries.at(-1)

    expect(() => delivery?.ack(), why).not.toThrow()
    expect(() => delivery?.nack(), why).not.toThrow()
    expect(channel.network.socket.sent, why).toHaveLength(before)
    expect(channel.network.socket.closedWith, why).toBeNull()
    expect(channel.network.sockets, why).toHaveLength(1)
  })

  it('writes down a frame it cannot read rather than dropping it in silence', async () => {
    const channel = await listening()

    channel.network.socket.pushFrame('not json at all {')
    channel.network.socket.pushFrame('"a string is not a payload"')

    expect(channel.log).toHaveLength(2)
    expect(channel.log.map(({ event }) => event)).toEqual([
      'gateway-undecodable',
      'gateway-undecodable',
    ])
  })

  it('writes down a socket fault rather than throwing it [fence:discord-socket-fault-not-thrown]', async () => {
    const why =
      'The socket’s error listener must write the fault down and never throw (ADR-0029, ' +
      'PubSubTransport’s reason). A listener that threw would take the process down over a ' +
      'network blip that is about to arrive as an ordinary close (#191).'
    const channel = await listening()

    expect(() => channel.network.socket.fail(new Error('connection reset')), why).not.toThrow()
    expect(channel.log, why).toContainEqual({ event: 'gateway-error', reason: 'connection reset' })
  })

  it('stops reconnecting when Discord refuses the connection for good [fence:discord-refused-for-good-stops]', async () => {
    const why =
      'A close with 4004, 4010, 4011, 4012, 4013 or 4014 — a bad token, a shard roma does not ' +
      'have, an API version that is gone, an intent roma is not approved for — must stop ' +
      'reconnecting and log gateway-refused (ADR-0029). Each is a deployment fact, so the next ' +
      'attempt fails identically and spends toward the ban; and the process stays up for other ' +
      'Channels, so without the line a Discord that never connects looks exactly like one ' +
      'nobody is talking to (#191).'
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await listening()
    await channel.take(HELLO)

    channel.network.socket.hangUp(4004)
    vi.advanceTimersByTime(RECONNECT_CEILING_MS)

    expect(channel.log, why).toContainEqual({ event: 'gateway-refused', code: 4004 })
    expect(channel.network.sockets, why).toHaveLength(1)
  })

  it('identifies afresh when the session is invalidated [fence:discord-reopen-does-not-wait-for-close]', async () => {
    const why =
      'Leaving a connection on purpose must run the close handling itself rather than wait ' +
      'for the socket to report its own close (ADR-0029). A real close is a handshake, so the ' +
      'event arrives late or never, and roma would sit disconnected waiting for it (#191).'
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await listening()
    await channel.take(HELLO)
    await channel.take(ready())

    await channel.take({ op: 9, d: false })
    vi.advanceTimersByTime(RECONNECT_FLOOR_MS)
    channel.network.socket.push(HELLO)

    expect(channel.network.socket.sentWith(OP_IDENTIFY), why).toHaveLength(1)
    expect(channel.network.socket.sentWith(OP_RESUME)).toEqual([])
  })

  it('closes the socket when roma stops, and does not come back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await connected()

    await channel.transport.close()
    vi.advanceTimersByTime(RECONNECT_CEILING_MS)

    expect(channel.network.sockets[0]?.closedWith).toBe(1000)
    expect(channel.network.sockets).toHaveLength(1)
  })
})

describe('where an answer goes', () => {
  it('opens a thread from a top-level message and answers in it', async () => {
    const channel = await messaged(addressed())

    await channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

    expect(channel.api.threads).toEqual([
      { channel: CHANNEL, message: MESSAGE, name: 'summarise this' },
    ])
    expect(channel.api.messages[0]?.posted).toEqual({
      channel: MESSAGE,
      text: 'the answer',
      replyTo: MESSAGE,
      buttons: [],
    })
  })

  it('answers in place in a thread and in a direct message', async () => {
    const inThread = await messaged(addressed({ channel_id: THREAD }))
    const direct = await messaged(inDm())

    await inThread.adapter.deliver(to(THREAD, { kind: 'result', text: 'in the thread' }))
    await direct.adapter.deliver(to(DM, { kind: 'result', text: 'in the dm' }))

    expect(inThread.api.threads).toEqual([])
    expect(direct.api.threads).toEqual([])
    expect(inThread.api.messages[0]?.posted.channel).toBe(THREAD)
    expect(direct.api.messages[0]?.posted.channel).toBe(DM)
  })

  it('opens no thread in a forum, because the key already put the reply in place', async () => {
    const post = '500000000000000015'
    const channel = await messaged(addressed({ channel_id: post }), [CHANNEL, FORUM])

    await channel.adapter.deliver(to(post, { kind: 'result', text: 'the answer' }))

    expect(channel.last?.conversationKey).toBe(post)
    expect(channel.api.threads).toEqual([])
    expect(channel.api.messages[0]?.posted.channel).toBe(post)
  })

  it('opens one thread however many messages a Task posts', async () => {
    const channel = await messaged(addressed())

    await channel.adapter.deliver(to(MESSAGE, { kind: 'progress', progress: { phase: 'working' } }))
    await channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

    expect(channel.api.threads).toHaveLength(1)
    expect(channel.api.messages.map(({ posted }) => posted.channel)).toEqual([MESSAGE, MESSAGE])
  })

  it('falls back to the channel the message arrived in when a thread is refused [fence:discord-thread-refusal-falls-back]', async () => {
    const why =
      'A refused thread must fall back to the channel the message arrived in and never end ' +
      'the delivery (ADR-0029). roma may hold no CREATE_PUBLIC_THREADS, the channel may be a ' +
      'forum, or a thread may have been read as top level; thrown, an answer somebody paid ' +
      'for reaches nobody, where fallen back only the Session is in the wrong place (#191).'
    const channel = await messaged(addressed())
    channel.api.failEvery('startThread', refusal(403))

    await channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

    expect(channel.api.messages[0]?.posted.channel, why).toBe(CHANNEL)
  })

  it('names a thread inside the hundred characters Discord will take [fence:discord-thread-name-fits]', async () => {
    const why =
      'A thread name must be at most 100 characters (ADR-0029). Discord refuses a longer one ' +
      'whole, and a refused thread costs the Conversation the Session its key was minted for — ' +
      'a limit that looks cosmetic is the one that loses a Session (#191).'
    const channel = await messaged(
      addressed({ content: `<@${ROMA}> ${'a first line that goes on '.repeat(10)}` }),
    )

    await channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

    const name = channel.api.threads[0]?.name ?? ''
    expect(name.length, why).toBeLessThanOrEqual(100)
    expect(name.startsWith('a first line that goes on')).toBe(true)
  })

  it('keeps answering where it fell back to, without asking again', async () => {
    const channel = await messaged(addressed())
    channel.api.failEvery('startThread', refusal(403))

    await channel.adapter.deliver(to(MESSAGE, { kind: 'progress', progress: { phase: 'working' } }))
    await channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

    expect(channel.api.threads).toHaveLength(1)
    expect(channel.api.messages.map(({ posted }) => posted.channel)).toEqual([CHANNEL, CHANNEL])
  })

  it('opens one thread for two instructions that arrive together [fence:discord-thread-asked-for-once]', async () => {
    const why =
      'The thread a Conversation is answered in must be remembered as a promise from the moment ' +
      'it is first asked for, not as a channel once Discord answers (ADR-0029). In between, a ' +
      'second instruction finds nothing and asks again — and a message can only ever start one ' +
      'thread, so the second request is a refusal spent on nothing (#191).'
    const channel = await messaged(addressed())

    await Promise.all([
      channel.adapter.deliver(to(MESSAGE, { kind: 'progress', progress: { phase: 'working' } })),
      channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' })),
    ])

    expect(channel.api.threads, why).toHaveLength(1)
  })

  it('asks for the thread again after an attempt that failed outright [fence:discord-failed-thread-forgotten]', async () => {
    const why =
      'A thread request that rejected must be forgotten, so the next instruction asks again ' +
      '(ADR-0028, ADR-0029). Kept, one bad minute leaves every later message in the ' +
      'Conversation waiting on a promise that has already rejected (#191).'
    const channel = await messaged(addressed())
    channel.api.failNext('startThread', refusal(429, RETRY_CEILING_MS + 1))

    await expect(
      channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' })),
    ).rejects.toThrow(/429/)
    await expect(
      channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }, 'task-2')),
      why,
    ).resolves.toBeUndefined()

    expect(channel.api.threads, why).toHaveLength(2)
    expect(
      channel.api.messages.map(({ posted }) => posted.channel),
      why,
    ).toEqual([MESSAGE])
  })

  it('writes down the channel it was refused a thread in, and answers anyway', async () => {
    const channel = await messaged(addressed())
    channel.api.failEvery('startThread', refusal(403))

    await channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

    expect(unopened(channel.log)).toEqual([
      { event: 'thread-unopened', channel: CHANNEL, status: 403 },
    ])
    expect(channel.api.messages[0]?.posted.channel).toBe(CHANNEL)
  })

  it('carries the number Discord refused with, rather than what roma makes of it', async () => {
    const noPermission = await messaged(addressed())
    noPermission.api.failEvery('startThread', refusal(403))
    const wrongKindOfChannel = await messaged(addressed())
    wrongKindOfChannel.api.failEvery('startThread', refusal(400))

    await noPermission.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))
    await wrongKindOfChannel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

    expect(unopened(noPermission.log)).toEqual([
      { event: 'thread-unopened', channel: CHANNEL, status: 403 },
    ])
    expect(unopened(wrongKindOfChannel.log)).toEqual([
      { event: 'thread-unopened', channel: CHANNEL, status: 400 },
    ])
  })

  it('says it once for a Task, and again for the next Conversation', async () => {
    const channel = await messaged(addressed())
    channel.api.failEvery('startThread', refusal(403))

    await channel.adapter.deliver(to(MESSAGE, { kind: 'progress', progress: { phase: 'working' } }))
    await channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))
    await channel.take(dispatch('MESSAGE_CREATE', addressed({ id: NEXT_MESSAGE })))
    await channel.adapter.deliver(to(NEXT_MESSAGE, { kind: 'result', text: 'the answer' }))

    expect(unopened(channel.log)).toEqual([
      { event: 'thread-unopened', channel: CHANNEL, status: 403 },
      { event: 'thread-unopened', channel: CHANNEL, status: 403 },
    ])
  })

  it('does not swallow a refusal it has run out of attempts on [fence:discord-refusal-not-swallowed]', async () => {
    const why =
      'deliver must reject when Discord refused and the attempts are spent (ADR-0028). ' +
      'Rejecting is how the Core learns the Conversation was not told, the one failure it ' +
      'cannot absorb; swallowed, the Core believes it was told (#191).'
    const channel = await messaged(inDm())
    channel.api.failEvery('post', refusal(403))

    await expect(
      channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' })),
      why,
    ).rejects.toThrow(/403/)
  })
})

describe('addressing the person who asked', () => {
  it('replies to the Caller’s message on the first piece and on nothing else [fence:discord-reply-on-first-piece-only]', async () => {
    const why =
      'Only the first piece of a split answer may carry replyTo (ADR-0029). The reply is what ' +
      'addresses the Caller on Discord, and Discord notifies on every one, so a reply on each ' +
      'piece notifies the Caller once per 2000 characters of one answer (#191).'
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'word '.repeat(2000) }))

    const replies = channel.api.messages.map(({ posted }) => posted.replyTo)
    expect(replies.length).toBeGreaterThan(2)
    expect(replies[0], why).toBe(MESSAGE)
    expect(
      replies.slice(1).every((replyTo) => replyTo === null),
      why,
    ).toBe(true)
  })

  it('says nothing in the text about who it is for', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(channel.api.texts).toEqual(['the answer'])
  })

  it('answers each of a thread’s two Callers on their own message [fence:discord-answering-by-caller]', async () => {
    const channel = await connected()
    await channel.take(dispatch('MESSAGE_CREATE', addressed({ id: 'ada-1', channel_id: THREAD })))
    await channel.take(
      dispatch(
        'MESSAGE_CREATE',
        addressed({ id: 'bob-1', channel_id: THREAD, author: person(SOMEBODY_ELSE) }),
      ),
    )

    await channel.adapter.deliver(to(THREAD, { kind: 'result', text: 'for Ada' }))
    await channel.adapter.deliver(
      to(THREAD, { kind: 'result', text: 'for Bob' }, 'task-2', SOMEBODY_ELSE, 'Bob'),
    )

    expect(
      channel.api.messages.map(({ posted }) => posted.replyTo),
      BY_CALLER,
    ).toEqual(['ada-1', 'bob-1'])
  })

  it('keeps two Conversations apart whose ids would run together [fence:discord-answering-by-caller]', async () => {
    const channel = await connected()
    await channel.take(
      dispatch('MESSAGE_CREATE', inDm({ id: 'ada-1', channel_id: '1', author: person('23') })),
    )
    await channel.take(
      dispatch('MESSAGE_CREATE', inDm({ id: 'bob-1', channel_id: '12', author: person('3') })),
    )

    await channel.adapter.deliver(to('1', { kind: 'result', text: 'for Ada' }, 'task-1', '23'))
    await channel.adapter.deliver(to('12', { kind: 'result', text: 'for Bob' }, 'task-2', '3'))

    expect(
      channel.api.messages.map(({ posted }) => [posted.channel, posted.replyTo]),
      BY_CALLER,
    ).toEqual([
      ['1', 'ada-1'],
      ['12', 'bob-1'],
    ])
  })
})

describe('what the Adapter remembers about a message', () => {
  it('forgets the oldest Conversation past REMEMBERED of them [fence:discord-answering-is-bounded]', async () => {
    const why =
      `#answering must hold at most REMEMBERED (${REMEMBERED}) entries, evicting the oldest ` +
      '(ADR-0029). roma runs for weeks and every top-level mention makes a Conversation, so ' +
      'one entry per Conversation ever seen is a leak with no ceiling. Eviction is cheap by ' +
      'design: the answer loses its reply, and a thread asked for again is a success (#191).'
    const channel = await messaged(inDm())
    for (let n = 0; n < REMEMBERED; n += 1) {
      await channel.take(dispatch('MESSAGE_CREATE', inDm({ id: `m-${n}`, channel_id: `dm-${n}` })))
    }

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'to the first' }))
    await channel.adapter.deliver(
      to(`dm-${REMEMBERED - 1}`, { kind: 'result', text: 'to the last' }, 'task-2'),
    )

    expect(
      channel.api.messages.map(({ posted }) => posted.replyTo),
      why,
    ).toEqual([null, `m-${REMEMBERED - 1}`])
  })

  it('keeps a Conversation somebody spoke in again ahead of one nobody has touched [fence:discord-answering-evicts-the-least-recent]', async () => {
    const why =
      '#answering must evict the Conversation least recently spoken in, not the one first seen ' +
      '(ADR-0029). A Map keeps the order keys were first set, so an entry has to be deleted ' +
      'before it is set again; otherwise a Conversation somebody has been talking in all day ' +
      'is evicted ahead of one nobody has touched since the morning, and loses its reply (#191).'
    const channel = await messaged(inDm())
    for (let n = 1; n < REMEMBERED - 1; n += 1) {
      await channel.take(dispatch('MESSAGE_CREATE', inDm({ id: `m-${n}`, channel_id: `dm-${n}` })))
    }
    await channel.take(dispatch('MESSAGE_CREATE', inDm({ id: NEXT_MESSAGE })))
    for (const n of ['new', 'newer']) {
      await channel.take(dispatch('MESSAGE_CREATE', inDm({ id: `m-${n}`, channel_id: `dm-${n}` })))
    }

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'to the first' }))
    await channel.adapter.deliver(to('dm-1', { kind: 'result', text: 'to the next' }, 'task-2'))

    expect(
      channel.api.messages.map(({ posted }) => posted.replyTo),
      why,
    ).toEqual([NEXT_MESSAGE, null])
  })

  it('keeps one acknowledgement for two updates sent together [fence:discord-acknowledgement-is-a-promise]', async () => {
    const why =
      '#acknowledgements must hold the promise of the acknowledgement from the moment it is ' +
      'posted, not its id once Discord answers (ADR-0003, ADR-0029). In between, a second ' +
      'update finds nothing, posts a second acknowledgement, and the Task has two messages ' +
      'mutating at once (#191).'
    const channel = await messaged(inDm())

    await Promise.all([
      channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } })),
      channel.adapter.deliver(
        to(DM, { kind: 'progress', progress: { phase: 'tool', tool: 'awk' } }),
      ),
    ])

    expect(channel.api.calls, why).toEqual(['post', 'edit'])
    expect(channel.api.messages, why).toHaveLength(1)
  })

  it('says it was refused a thread on stderr where nobody gave it a log [fence:discord-adapter-log-defaults-to-stderr]', async () => {
    const why =
      'DiscordAdapter’s log must default to stderr, not to silence (ADR-0029). thread-unopened ' +
      'is the only evidence that every message in a channel is getting a Session of its own: ' +
      'the reply still arrives and no Task fails, so a deployment that drops the line gets back ' +
      'exactly the invisible fault the record exists to end (#191).'
    const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const api = new RecordingDiscordApi()
      api.failEvery('startThread', refusal(403))
      const adapter = new DiscordAdapter({ api, wait: () => Promise.resolve() })
      adapter.toIngress({
        message: addressed(),
        self: ROMA,
        guildChannel: true,
        quotation: null,
        press: null,
      })

      await adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

      expect(written.mock.calls.map(([line]) => String(line)).join(''), why).toContain(
        '"event":"thread-unopened"',
      )
    } finally {
      written.mockRestore()
    }
  })
})

describe('an answer longer than Discord will take', () => {
  it('splits the recorded 17,706-character Turn into twelve messages', async () => {
    const channel = await messaged(inDm())
    const answer = recordedAnswer()

    await channel.adapter.deliver(to(DM, { kind: 'result', text: answer }))

    expect(answer).toHaveLength(17706)
    expect(channel.api.messages).toHaveLength(12)
    for (const message of channel.api.messages) {
      expect(message.text.length).toBeLessThanOrEqual(MAX_TEXT)
    }
    expect(channel.api.texts.join('\n\n').replace(/\s+/g, ' ')).toBe(answer.replace(/\s+/g, ' '))
  })

  it('breaks at a paragraph boundary, in order', async () => {
    const channel = await messaged(inDm())
    const paragraphs = Array.from({ length: 12 }, (_, n) =>
      `Paragraph ${n}. ${'word '.repeat(60)}`.trim(),
    )

    await channel.adapter.deliver(to(DM, { kind: 'result', text: paragraphs.join('\n\n') }))

    expect(channel.api.messages.length).toBeGreaterThan(1)
    for (const text of channel.api.texts) {
      expect(text.startsWith('Paragraph ')).toBe(true)
      expect(text.endsWith('word')).toBe(true)
    }
  })

  it('splits a failure the same way it splits an answer', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(
      to(DM, { kind: 'failure', reason: `Failed after ${'a very long explanation '.repeat(400)}` }),
    )

    expect(channel.api.messages.length).toBeGreaterThan(1)
    for (const message of channel.api.messages) {
      expect(message.text.length).toBeLessThanOrEqual(MAX_TEXT)
    }
  })

  it('cuts text with no late break hard, rather than into scraps [fence:discord-split-no-tiny-pieces]', async () => {
    const why =
      'A split may only break at a boundary in the second half of its window (ADR-0029). ' +
      'Text with a break near the start and none after it would otherwise come out as a ' +
      'message of two words, then the rest — a long answer posted as scraps (#191).'
    const channel = await messaged(inDm())

    await channel.adapter.deliver(
      to(DM, { kind: 'result', text: `three short words ${'x'.repeat(5000)}` }),
    )

    expect(channel.api.messages.length).toBeGreaterThan(1)
    for (const text of channel.api.texts.slice(0, -1)) {
      expect(text.length, why).toBeGreaterThan(MAX_TEXT / 2)
    }
  })

  it('says something even when a Turn produced no text at all', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'result', text: '' }))

    expect(channel.api.messages).toHaveLength(1)
    expect(channel.api.texts[0]).not.toBe('')
  })
})

const ACKNOWLEDGEMENT_KEPT =
  'A Task’s acknowledgement must be forgotten only on an instruction that ends the Task, and ' +
  'before that instruction is posted (ADR-0003, ADR-0029). Forgotten on `blocked`, ' +
  '`overflow-refused` or `context-full`, the message the person is watching is stranded and a ' +
  'second one is posted when the Task goes on; forgotten after the post, a post that throws ' +
  'leaves it behind for good (#29, #191).'

describe('the acknowledgement', () => {
  it('is edited in place rather than posted again', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } }))
    await channel.adapter.deliver(
      to(DM, { kind: 'progress', progress: { phase: 'tool', tool: 'awk' } }),
    )
    await channel.adapter.deliver(
      to(DM, { kind: 'progress', progress: { phase: 'writing', characters: 14 } }),
    )

    expect(channel.api.calls).toEqual(['post', 'edit', 'edit'])
    expect(channel.api.messages).toHaveLength(1)
    expect(channel.api.messages[0]).toMatchObject({ text: 'Writing… (14 chars)', edits: 2 })
  })

  it('is never what the result is written into [fence:discord-result-is-its-own-message]', async () => {
    const why =
      'A result must be posted as a message of its own, never edited into the acknowledgement ' +
      '(ADR-0003). Discord’s search and its quote-reply reach only the content of a message ' +
      'somebody can point at, and an edited-over acknowledgement is not one (#191).'
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } }))
    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(channel.api.calls, why).toEqual(['post', 'post'])
    expect(channel.api.texts, why).toEqual(['Working…', 'the answer'])
  })

  it('is one per Task, not one per Conversation', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } }))
    await channel.adapter.deliver(
      to(DM, { kind: 'progress', progress: { phase: 'queued', position: 2 } }, 'task-2'),
    )

    expect(channel.api.calls).toEqual(['post', 'post'])
    expect(channel.api.texts).toEqual(['Working…', 'Queued — 2 waiting.'])
  })

  it('is finished with once the Task ends', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } }))
    await channel.adapter.deliver(to(DM, { kind: 'stopped' }))
    await channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } }))

    expect(channel.api.calls).toEqual(['post', 'post', 'post'])
  })

  it('keeps the one it was mutating for a message that is not an ending [fence:discord-acknowledgement-kept-until-the-end]', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } }))
    await channel.adapter.deliver(to(DM, { kind: 'context-full' }))
    await channel.adapter.deliver(
      to(DM, { kind: 'progress', progress: { phase: 'writing', characters: 14 } }),
    )

    expect(channel.api.calls, ACKNOWLEDGEMENT_KEPT).toEqual(['post', 'post', 'edit'])
  })

  it('forgets it at the end even where the ending could not be posted [fence:discord-acknowledgement-kept-until-the-end]', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } }))
    channel.api.failNext('post', refusal(403))
    await expect(channel.adapter.deliver(to(DM, { kind: 'stopped' }))).rejects.toThrow(/403/)
    await channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } }))

    expect(channel.api.calls, ACKNOWLEDGEMENT_KEPT).toEqual(['post', 'post', 'post'])
  })

  it('tries again after a post that failed, rather than editing nothing [fence:discord-failed-acknowledgement-forgotten]', async () => {
    const why =
      'An acknowledgement whose post failed must be forgotten (ADR-0029). It left no message ' +
      'to edit, so kept, every later update for the Task edits an id that never existed and ' +
      'fails with an error from minutes ago (#191).'
    const channel = await messaged(inDm())
    channel.api.failNext('post', refusal(403))

    await expect(
      channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } })),
    ).rejects.toThrow(/403/)
    await channel.adapter.deliver(
      to(DM, { kind: 'progress', progress: { phase: 'tool', tool: 'awk' } }),
    )

    expect(channel.api.calls, why).toEqual(['post', 'post'])
    expect(channel.api.texts, why).toEqual(['Running awk…'])
  })

  it('quotes only as much of a tool command as can be read at a glance', async () => {
    const channel = await messaged(inDm())
    const tool = `awk ${'-v x=1 '.repeat(1000)}`

    await channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'tool', tool } }))

    const text = channel.api.texts[0] ?? ''
    expect(text.length).toBe('Running '.length + 120 + '…'.length)
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT)
    expect(text.startsWith('Running awk -v x=1 ')).toBe(true)
  })
})

describe('what a Conversation is told', () => {
  it('says what happened, in words a person can act on', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'stopped' }))
    await channel.adapter.deliver(
      to(DM, { kind: 'command-outcome', command: 'stop', carriedOut: false }),
    )
    await channel.adapter.deliver(
      to(DM, { kind: 'command-outcome', command: 'clear', carriedOut: true }),
    )
    await channel.adapter.deliver(
      to(DM, { kind: 'failure', reason: 'roma could not run this Task.' }),
    )

    expect(channel.api.texts).toEqual([
      'Stopped.',
      'Nothing to stop.',
      expect.stringContaining('fresh session'),
      'roma could not run this Task.',
    ])
  })

  it('says quota is spent, when it comes back, and that the Task is kept', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(
      to(DM, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: true }),
    )

    expect(channel.api.texts).toEqual([
      'The shared Claude quota is spent. It comes back at 2026-07-28 20:40 UTC — I have kept your task and will run it then.',
    ])
  })

  it('says what the cap was when Overflow is refused, and that the Task waits on', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'overflow-refused', capUsd: 20, spentUsd: 21.5 }))

    expect(channel.api.texts).toEqual([
      'Overflow is capped at $20.00 a month and this month has spent $21.50, so it is off ' +
        'until the month turns. Your task is still waiting for the shared quota to reset.',
    ])
  })

  it('names /clear when the context cannot be reduced any further', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'context-full' }))

    expect(channel.api.texts).toEqual([
      'Claude cannot shorten this conversation any further, so it cannot take another ' +
        'message. Send /clear to start a fresh session — nothing from this one carries over.',
    ])
  })

  it('posts a Menu as the words it already is', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(
      to(DM, {
        kind: 'choice',
        text: 'This conversation is on sonnet (claude-sonnet-5). You can choose: fable, opus, sonnet, haiku, default.',
        chooses: 'model',
        options: ['fable', 'opus', 'sonnet', 'haiku', 'default'],
        refused: null,
      }),
    )

    expect(channel.api.texts).toEqual([
      'This conversation is on sonnet (claude-sonnet-5). You can choose: fable, opus, sonnet, haiku, default.',
    ])
  })

  it('posts the answer and then what an Overflow Turn cost', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'done', overflowCostUsd: 0.42 }))

    expect(channel.api.texts).toEqual(['done', 'Ran on metered billing: $0.42.'])
  })

  it('does not price a Turn nothing priced [fence:discord-null-cost-not-free]', async () => {
    const why =
      'A null Overflow cost must be said as unreported, never as $0.00 (ADR-0002). "$0.00" ' +
      'reports metered money as free, the one claim the Audit Record refuses to make about a ' +
      'Turn nothing priced (#191).'
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'done', overflowCostUsd: null }))

    expect(channel.api.texts, why).toEqual([
      'done',
      'Ran on metered billing. What it cost was never reported.',
    ])
  })

  it('declares message mutation and a stable Conversation Key', async () => {
    const { adapter } = await listening()

    expect(adapter.capabilities).toEqual({ messageMutation: true, stableConversationKey: true })
  })

  it('says the Opening first, and acknowledges underneath it', async () => {
    const channel = await messaged(addressed())

    await channel.adapter.deliver(
      to(MESSAGE, { kind: 'result', text: 'Running on claude-sonnet-5.' }, 'opening-1'),
    )
    await channel.adapter.deliver(to(MESSAGE, { kind: 'progress', progress: { phase: 'working' } }))

    expect(channel.api.texts).toEqual(['Running on claude-sonnet-5.', 'Working…'])
    expect(channel.api.messages.map(({ posted }) => posted.channel)).toEqual([MESSAGE, MESSAGE])
    expect(channel.api.threads).toHaveLength(1)
  })
})

describe('a Menu, out as buttons and back as a press', () => {
  it('draws one button per option, in the order the Menu lists them', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))

    expect(channel.buttons.map(({ label }) => label)).toEqual(MENU_NAMES)
    expect(MENU_NAMES).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'default'])
  })

  it('draws the whole Effort Menu, past the width of one row', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, choice('effort', EFFORT_NAMES)))

    expect(channel.buttons.map(({ label }) => label)).toEqual(EFFORT_NAMES)
    expect(EFFORT_NAMES.length).toBeGreaterThan(5)
  })

  it('draws the Caveman Menu whole, and the operator’s two levels nowhere on it', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, choice('caveman', CAVEMAN_NAMES)))

    expect(channel.buttons.map(({ label }) => label)).toEqual(CAVEMAN_NAMES)
    expect(CAVEMAN_NAMES).toEqual(['off', 'lite', 'full', 'ultra', 'wenyan-full', 'default'])
    for (const withheld of OFF_MENU_WENYAN) {
      expect(channel.buttons.map(({ label }) => label)).not.toContain(withheld)
    }
  })

  it('draws no buttons at all for a Menu wider than one message holds [fence:discord-menu-whole-or-not-at-all]', async () => {
    const why =
      'A Menu wider than MAX_BUTTONS must be drawn as no buttons, never as its first ' +
      'MAX_BUTTONS (ADR-0023). A card carrying part of a Menu says those are all the names ' +
      'there are, and the rest cannot be reached by pressing anything; drawn as nothing it is ' +
      'correct, because the text names every name (#191).'
    const channel = await messaged(inDm())
    const wide = Array.from({ length: MAX_BUTTONS + 1 }, (_, at) => `option-${at}`)

    await channel.adapter.deliver(to(DM, choice('model', wide)))

    expect(channel.buttons, why).toEqual([])
    expect(channel.api.messages.at(-1)?.text).toContain(`option-${MAX_BUTTONS}`)
  })

  it('spends a custom_id Discord will take [fence:discord-custom-id-fits]', async () => {
    const why =
      `Every custom_id roma posts must be 1-${MAX_CUSTOM_ID} characters (ADR-0023, ADR-0029). ` +
      'Discord refuses a message carrying a longer one whole: a Menu nobody is shown, and on ' +
      'the blocked path an Overflow offer that never reaches the person waiting on it (#191).'
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, choice('effort', EFFORT_NAMES)))
    await channel.adapter.deliver(
      to(DM, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: true }),
    )

    for (const { customId } of channel.api.messages.flatMap(({ posted }) => posted.buttons)) {
      expect(customId.length, why).toBeGreaterThanOrEqual(1)
      expect(customId.length, why).toBeLessThanOrEqual(MAX_CUSTOM_ID)
    }
  })

  it('reads a press as the message the Caller would have typed [fence:discord-press-has-its-own-reader] [fence:discord-presser-off-the-event]', async () => {
    const presser =
      'A press’s Caller must be read off the interaction’s member.user (or user), never off ' +
      'message.author (ADR-0023). The card is roma’s own message, so its author is roma, and ' +
      'every Menu choice would be credited to roma rather than to whoever pressed (#191).'
    const channel = await messaged(inDm())
    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))

    await channel.take(press(customIdFor(channel.buttons, 'opus')))

    expect(channel.last, OWN_READER).toMatchObject({ text: '/model opus' })
    expect(channel.last, presser).toMatchObject({ caller: CALLER, callerName: 'Ada' })
    expect(readCommand(channel.last?.text ?? '')).toEqual({ command: 'model', argument: 'opus' })
  })

  it('reads every name on every Menu back as the Command a Caller would have typed [fence:discord-every-menu-name-reads-back]', async () => {
    const why =
      'choiceButtons and the Command guard in readPress are one fact in two files and must ' +
      'widen together (ADR-0023). Half a widening is a custom_id roma writes onto a button ' +
      'and then refuses to read: nothing fails, nothing is logged, and a Caller presses and ' +
      'goes on waiting (#191, #192).'
    const menus = [
      { chooses: 'model' as const, names: MENU_NAMES },
      { chooses: 'effort' as const, names: EFFORT_NAMES },
      { chooses: 'caveman' as const, names: CAVEMAN_NAMES },
    ]

    for (const { chooses, names } of menus) {
      const channel = await messaged(inDm())
      await channel.adapter.deliver(to(DM, choice(chooses, names)))
      expect(channel.buttons, why).toHaveLength(names.length)

      for (const [at, { label, customId }] of channel.buttons.entries()) {
        await channel.take(press(customId, { id: `90000000000000002${at}` }))
        expect(readCommand(channel.last?.text ?? ''), why).toEqual({
          command: chooses,
          argument: label,
        })
      }
    }
  })

  it('reads a Caveman press, hyphen and all, as the Command it stands for', async () => {
    const channel = await messaged(inDm())
    await channel.adapter.deliver(to(DM, choice('caveman', CAVEMAN_NAMES)))

    await channel.take(press(customIdFor(channel.buttons, 'wenyan-full')))

    expect(channel.last).toMatchObject({ text: '/caveman wenyan-full', caller: CALLER })
    expect(readCommand(channel.last?.text ?? '')).toEqual({
      command: 'caveman',
      argument: 'wenyan-full',
    })
  })

  it('carries the Conversation Key the card was posted for', async () => {
    const channel = await messaged(addressed())
    await channel.adapter.deliver(to(MESSAGE, choice('effort', EFFORT_NAMES)))

    await channel.take(press(customIdFor(channel.buttons, 'xhigh')))

    expect(channel.last?.conversationKey).toBe(MESSAGE)
  })

  it('is right about the Conversation even where the card is not in it [fence:discord-press-survives-thread-fallback]', async () => {
    const why =
      'A press must take its Conversation Key off the button, never off the channel the card ' +
      'sits in, and must be remembered like a message so its answer goes to the channel the ' +
      'card is in (ADR-0023, ADR-0029). Where roma was refused the thread, the card sits in ' +
      'the parent channel, whose id is not the key: read off channel_id the press answers a ' +
      'Conversation nobody was in, and not remembered its answer goes to the id of a thread ' +
      'that was never opened (#191).'
    const posting = await messaged(addressed())
    posting.api.failEvery('startThread', refusal(403))
    await posting.adapter.deliver(to(MESSAGE, choice('model', MENU_NAMES)))
    expect(posting.api.messages.at(-1)?.posted.channel).toBe(CHANNEL)

    const restarted = await connected()
    restarted.api.failEvery('startThread', refusal(403))
    await restarted.take(
      press(customIdFor(posting.buttons, 'haiku'), { message: card({ channel_id: CHANNEL }) }),
    )

    expect(restarted.last?.conversationKey, why).toBe(MESSAGE)
    expect(sessionIdFor(restarted.last?.conversationKey ?? '')).toBe(sessionIdFor(MESSAGE))
    await restarted.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'Now on haiku.' }))
    expect(restarted.api.messages.at(-1)?.posted.channel, why).toBe(CHANNEL)
  })

  it('answers a press on a card posted before roma last started', async () => {
    const posting = await messaged(addressed())
    await posting.adapter.deliver(to(MESSAGE, choice('model', MENU_NAMES)))
    const pressed = customIdFor(posting.buttons, 'sonnet')

    const restarted = await connected()
    await restarted.take(press(pressed))

    expect(restarted.last).toMatchObject({ conversationKey: MESSAGE, text: '/model sonnet' })
    await restarted.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'Now on sonnet.' }))
    expect(restarted.api.messages.at(-1)?.posted.channel).toBe(MESSAGE)
  })

  it('draws nothing on the reply a suppressed Menu arrives as', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(
      to(DM, {
        kind: 'result',
        text: 'This conversation runs at max. claude-haiku-4-5 takes none.',
      }),
    )

    expect(channel.buttons).toEqual([])
  })

  it('puts the buttons under the last piece of a split answer and no other [fence:discord-buttons-on-last-piece-only]', async () => {
    const why =
      'Only the last piece of a split answer may carry its buttons (ADR-0023). Buttons belong ' +
      'under the words that name them, and on every piece the whole Menu repeats under each ' +
      '2000 characters of one answer (#191).'
    const channel = await messaged(inDm())

    await channel.adapter.deliver(
      to(DM, choice('model', MENU_NAMES, `${'word '.repeat(2000)}You can choose:`)),
    )

    const drawn = channel.api.messages.map(({ posted }) => posted.buttons.length)
    expect(drawn.length).toBeGreaterThan(1)
    expect(
      drawn.slice(0, -1).every((count) => count === 0),
      why,
    ).toBe(true)
    expect(drawn.at(-1), why).toBe(MENU_NAMES.length)
  })
})

describe('the Overflow offer, out as a button and back as a press', () => {
  it('offers Overflow on the message that reports the block', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(
      to(DM, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: true }),
    )

    expect(channel.buttons.map(({ label }) => label)).toEqual([OVERFLOW_BUTTON])
  })

  it('words the offer as Chat does [fence:discord-overflow-worded-as-chat]', () => {
    const why =
      'Taking Overflow is one decision, whichever Channel draws the button: what it costs must ' +
      'read the same everywhere (ADR-0002). Two Channels wording it differently would be two ' +
      'decisions, and the label is the only place a Caller is told that pressing it spends money.'
    expect(OVERFLOW_BUTTON, why).toBe(CHAT_OVERFLOW_BUTTON)
  })

  it('offers none where the Core says there is none to offer', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(
      to(DM, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: false }),
    )

    expect(channel.buttons).toEqual([])
  })

  it('takes the offer for the Task it was made about [fence:discord-overflow-named-by-task]', async () => {
    const why =
      'The Overflow button must carry the Task id, never the Conversation (ADR-0002). A ' +
      'Conversation can have a second Task blocked behind the first, so "the blocked Task ' +
      'here" spends money on whichever roma looked at first. Anyone in the Conversation may ' +
      'press it, which is ADR-0002’s decision rather than an oversight (#191).'
    const channel = await messaged(inDm())
    await channel.adapter.deliver(
      to(DM, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: true }, 'task-7'),
    )
    const first = customIdFor(channel.buttons, OVERFLOW_BUTTON)
    await channel.adapter.deliver(
      to(DM, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: true }, 'task-8'),
    )
    const second = customIdFor(channel.buttons, OVERFLOW_BUTTON)

    await channel.take(press(first))
    const takingFirst = channel.deliveries.at(-1)?.event as DiscordEvent
    await channel.take(press(second, { id: '900000000000000019' }))
    const takingSecond = channel.deliveries.at(-1)?.event as DiscordEvent

    expect(channel.adapter.toOverflowTaken(takingFirst), why).toBe('task-7')
    expect(channel.adapter.toOverflowTaken(takingSecond), why).toBe('task-8')
  })

  it('tells the two presses apart in the order the subscriber asks', async () => {
    const channel = await messaged(inDm())
    await channel.adapter.deliver(
      to(DM, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: true }, 'task-7'),
    )
    const offer = customIdFor(channel.buttons, OVERFLOW_BUTTON)
    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))
    const menu = customIdFor(channel.buttons, 'opus')

    await channel.take(press(offer))
    const takingOverflow = channel.deliveries.at(-1)?.event as DiscordEvent
    await channel.take(press(menu, { id: '900000000000000019' }))
    const choosing = channel.deliveries.at(-1)?.event as DiscordEvent

    expect(channel.adapter.toIngress(takingOverflow)).toBeNull()
    expect(channel.adapter.toOverflowTaken(takingOverflow)).toBe('task-7')
    expect(channel.adapter.toIngress(choosing)).toMatchObject({ text: '/model opus' })
    expect(channel.adapter.toOverflowTaken(choosing)).toBeNull()
  })

  it('reads every id it writes as one kind and never as the other [fence:discord-press-is-one-kind]', () => {
    const why =
      'Every custom_id roma writes must read back as exactly the kind it was written as. ' +
      'Ingress.#workFor asks toIngress before toOverflowTaken (src/serve.ts), so an Overflow ' +
      'offer read as a Menu press, or the reverse, turns taking an offer into a paid Task ' +
      'nobody asked for, or spends money on a Task roma never named (ADR-0002, ADR-0029).'
    const keys = ['1', MESSAGE, 'overflow:task-1']
    const names = [
      'opus',
      'default',
      'wenyan-full',
      'a:name:with:separators',
      'overflow',
      'choose:x',
    ]
    const tasks = ['task-7', 'task:7', 'choose:model:1:opus', 'overflow', MESSAGE]

    const menu = keys.flatMap((key) =>
      names.flatMap((name) => [
        chooseId('model', key, name),
        chooseId('effort', key, name),
        chooseId('caveman', key, name),
      ]),
    )
    const offers = tasks.map((taskId) => overflowId(taskId))

    for (const customId of menu) {
      expect(readPress(customId)?.kind, `${why} (${customId})`).toBe('choose')
    }
    expect(
      offers.map((customId) => readPress(customId)),
      why,
    ).toEqual(tasks.map((taskId) => ({ kind: 'overflow', taskId })))
  })

  it('reads a Menu name back whole, separators and all [fence:discord-option-rides-last]', () => {
    const why =
      'The option must be the last field of a Menu custom_id and be rejoined on the way back ' +
      '(ADR-0023). It is the only field whose spelling is not roma’s to bound: placed before ' +
      'another field, a Menu re-audited onto a name with a ":" in it arrives cut in half, ' +
      'naming a Conversation or an option nobody chose (#191).'
    for (const key of ['1', MESSAGE]) {
      for (const option of ['opus', 'wenyan-full', 'a:name:with:separators', 'choose:x']) {
        expect(readPress(chooseId('caveman', key, option)), why).toEqual({
          kind: 'choose',
          chooses: 'caveman',
          conversationKey: key,
          option,
        })
      }
    }
  })

  it('reads no Command off a press but one with a Menu [fence:discord-menu-door-opens-only-menus]', async () => {
    const why =
      'A press may only ever read as /model, /effort or /caveman (ADR-0023). A custom_id ' +
      'naming any other Command is one roma never put out, and synthesising /stop or /clear ' +
      'from it reaches a Command through a door meant for a Menu (#191).'
    const elsewhere = commandSpellings()
      .map((spelling) => readCommand(spelling)?.command)
      .filter((command) => command !== 'model' && command !== 'effort' && command !== 'caveman')
    expect(elsewhere.length).toBeGreaterThan(0)

    const channel = await messaged(inDm())
    for (const [at, command] of elsewhere.entries()) {
      const forged = `choose:${String(command)}:${DM}:now`
      await channel.take(press(forged, { id: `90000000000000003${at}` }))
      const event = channel.deliveries.at(-1)?.event as DiscordEvent

      expect(readPress(forged), `${why} (${forged})`).toBeNull()
      expect(channel.adapter.toIngress(event), `${why} (${forged})`).toBeNull()
    }
  })
})

describe('a press is acknowledged before anything answers it', () => {
  it('says the press arrived before the event is handed on [fence:discord-press-acknowledged-first]', async () => {
    const channel = await messaged(inDm())
    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))

    await channel.take(press(customIdFor(channel.buttons, 'opus')))

    expect(channel.api.acknowledged, ACKNOWLEDGED_FIRST).toEqual([
      { interactionId: INTERACTION, token: INTERACTION_TOKEN },
    ])
    expect(channel.saidBefore.at(-1), ACKNOWLEDGED_FIRST).toContain('acknowledgePress')
  })

  it('leaves the card exactly as it was', async () => {
    const channel = await messaged(inDm())
    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))
    const before = channel.api.messages.map(({ text, edits }) => ({ text, edits }))

    await channel.take(press(customIdFor(channel.buttons, 'opus')))

    expect(channel.api.calls).not.toContain('edit')
    expect(channel.api.messages.map(({ text, edits }) => ({ text, edits }))).toEqual(before)
  })

  it('answers a press it could not acknowledge, and writes down that it could not [fence:discord-press-acknowledged-first]', async () => {
    const channel = await messaged(inDm())
    channel.api.failEvery('acknowledgePress', refusal(404))
    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))

    await channel.take(press(customIdFor(channel.buttons, 'opus')))

    expect(channel.last, ACKNOWLEDGED_FIRST).toMatchObject({ text: '/model opus' })
    expect(channel.log, ACKNOWLEDGED_FIRST).toContainEqual({
      event: 'press-unacknowledged',
      reason: expect.any(String),
    })
  })

  it('names a Delivery by the press rather than by the card [fence:discord-delivery-named-by-press]', async () => {
    const why =
      'A press’s Delivery must be named by the interaction’s id, never the card’s message id ' +
      '(ADR-0028). Two presses on one card are two events; named by the card, the second ' +
      'looks like the first arriving twice and Ingress.take drops it while the first is still ' +
      'running (#191).'
    const channel = await messaged(inDm())
    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))

    await channel.take(press(customIdFor(channel.buttons, 'opus')))
    await channel.take(press(customIdFor(channel.buttons, 'haiku'), { id: '900000000000000019' }))

    expect(
      channel.deliveries.slice(-2).map(({ id }) => id),
      why,
    ).toEqual([INTERACTION, '900000000000000019'])
  })

  it('spends no round trip quoting the card a press is on [fence:discord-press-quotes-nothing]', async () => {
    const why =
      'A press must never have its Quotation completed (ADR-0029). The card is roma’s own ' +
      'reply to the Caller, so completing its message_reference spends a REST round trip, ' +
      'out of the same rate limits every answer needs, quoting the question the press ' +
      'answers (#191).'
    const channel = await messaged(inDm())
    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))
    channel.api.holds(DM, MESSAGE, inDm())

    await channel.take(
      press(customIdFor(channel.buttons, 'opus'), {
        message: card({ channel_id: DM, message_reference: { message_id: MESSAGE } }),
      }),
    )

    expect(channel.api.calls, why).not.toContain('message')
    expect(channel.last?.quotation, why).toBeNull()
  })

  it('acknowledges nothing that is not a press on something roma posted', async () => {
    const channel = await messaged(inDm())

    await channel.take(press('choose:model:1:opus', { type: 2 }))

    expect(channel.api.acknowledged).toEqual([])
    expect(channel.deliveries).toHaveLength(1)
  })

  it('answers nothing for a custom_id roma never put out', async () => {
    const channel = await messaged(inDm())

    await channel.take(press('something-roma-never-wrote'))

    expect(channel.api.acknowledged).toHaveLength(1)
    const event = channel.deliveries.at(-1)?.event as DiscordEvent
    expect(channel.adapter.toIngress(event)).toBeNull()
    expect(channel.adapter.toOverflowTaken(event)).toBeNull()
  })
})

describe('a call Discord refused', () => {
  it('waits exactly as long as Discord asked before trying again [fence:discord-waits-what-discord-asked]', async () => {
    const why =
      'A retry after a 429 must wait the Retry-After Discord sent, never a time of roma’s ' +
      'own (ADR-0029). A 429 counts toward the 10,000-per-10-minutes invalid-request limit, ' +
      'whose penalty is a block on the whole API, the Gateway included, not on the channel ' +
      'that earned it.'
    const channel = await messaged(inDm())
    channel.api.failNext('post', refusal(429, 1_500))

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(channel.waits, why).toEqual([1_500])
    expect(channel.api.texts, why).toEqual(['the answer'])
  })

  it('backs off on its own clock where Discord named no time', async () => {
    const channel = await messaged(inDm())
    channel.api.failNext('post', refusal(503))

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(channel.waits).toEqual([RETRY_FLOOR_MS])
  })

  it('gives up rather than trying for ever [fence:discord-attempts-bounded]', async () => {
    const why =
      `A Discord call must be made at most ATTEMPTS (${ATTEMPTS}) times (ADR-0028, ADR-0029). ` +
      'A loop that kept trying turns one unreachable Conversation into an outage of every ' +
      'Conversation, the Gateway included: every refused attempt counts toward an ' +
      'invalid-request budget whose block is on the whole API (#191).'
    const channel = await messaged(inDm())
    channel.api.failEvery('post', refusal(429, 100))

    await expect(
      channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' })),
    ).rejects.toThrow(/429/)
    expect(
      channel.api.calls.filter((call) => call === 'post'),
      why,
    ).toHaveLength(ATTEMPTS)
  })

  it('gives up rather than sleeping through a ban [fence:discord-no-sleeping-through-a-ban]', async () => {
    const why =
      `A Retry-After longer than RETRY_CEILING_MS (${RETRY_CEILING_MS}) must be given up on, ` +
      'not slept through (ADR-0028, ADR-0029). A wait that long is a block on the whole API ' +
      'rather than a bucket refilling, and sleeping inside deliver holds the Task, the ' +
      'Session’s Opening and everything queued behind them for as long as it lasts (#191).'
    const channel = await messaged(inDm())
    channel.api.failEvery('post', refusal(429, RETRY_CEILING_MS + 1))

    await expect(
      channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' })),
    ).rejects.toThrow(/429/)
    expect(channel.waits, why).toEqual([])
    expect(
      channel.api.calls.filter((call) => call === 'post'),
      why,
    ).toHaveLength(1)
  })

  it('does not try again where trying again cannot work [fence:discord-retry-only-what-can-work]', async () => {
    const channel = await messaged(inDm())
    channel.api.failEvery('post', refusal(403))

    await expect(
      channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' })),
    ).rejects.toThrow(/403/)
    expect(channel.waits, RETRY_WHAT_CAN_WORK).toEqual([])
    expect(
      channel.api.calls.filter((call) => call === 'post'),
      RETRY_WHAT_CAN_WORK,
    ).toHaveLength(1)
  })

  it('treats a re-attempted thread as the thread it wanted, and posts into it', async () => {
    const channel = await messaged(addressed())
    channel.api.failNext('startThread', refusal(500))

    await channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

    expect(channel.api.threads).toHaveLength(2)
    expect(channel.api.messages[0]?.posted.channel).toBe(MESSAGE)
  })

  it('tries again after a fault that never reached Discord at all [fence:discord-retry-only-what-can-work]', async () => {
    const channel = await messaged(inDm())
    channel.api.failNext('post', new Error('socket hang up'))

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(channel.api.texts, RETRY_WHAT_CAN_WORK).toEqual(['the answer'])
  })
})

const STRIPS_ITS_OWN =
  'readIngressMessage must strip roma’s own mention, both spellings, and no other (ADR-0023). ' +
  'Discord does not strip it and readCommand matches the whole message, so left in, ' +
  '"<@roma> /stop" matches nothing and becomes a paid Task; and anybody else’s mention is ' +
  'content somebody typed, so removing it edits what the model is asked about (#191).'

const EITHER_HALF =
  'Whether a guild message addressed roma must be read off both the mentions list and the ' +
  'literal mention in the words (ADR-0029). Each survives a delivery the other does not, so ' +
  'a reader taking either alone answers nothing on whichever half carries the other (#191).'

const OWN_READER =
  'A press must be read by readChosenOption, never routed through readIngressMessage ' +
  '(ADR-0023). The message on a press is roma’s own card, authored by an application: the bot ' +
  'guard swallows it, and relaxing the guard to let it through re-opens two apps answering ' +
  'each other and credits the choice to roma (#191).'

const BY_CALLER =
  '#answering must be keyed by Conversation and Caller, joined by something no snowflake can ' +
  'hold (ADR-0009, ADR-0029). A thread is many people sharing one Conversation with Tasks in ' +
  'flight at once, so keyed on the Conversation alone — or on two ids run together — Ada’s ' +
  'answer replies to Bob’s question (#191).'

const DETACHED =
  'A delivery must run beside the socket and derive its key from the guild as it stood when ' +
  'the frame arrived (ADR-0028, ADR-0029). A Task takes minutes, so a frame handler that waits ' +
  'on one stops reading the socket; and a key read after the Quotation’s round trip is ' +
  'derived from the guild as it stands later, not as the message found it (#191).'

const ACKNOWLEDGED_FIRST =
  'A press must be acknowledged before it is handed on, and handed on even where the ' +
  'acknowledgement failed (ADR-0029). Discord invalidates the token after three seconds and ' +
  'roma’s Core takes minutes, so the acknowledgement cannot wait on the work; and a press ' +
  'nothing answers is worse than one Discord marks failed (#191).'

const RETRY_WHAT_CAN_WORK =
  'A call must be retried exactly where retrying could work (ADR-0028). A refusal — a 4xx ' +
  'other than 429 — will be refused again, and every attempt spends toward the block on the ' +
  'whole API; anything that is not a DiscordRefusal never reached Discord, and left unretried ' +
  'an answer somebody paid for reaches nobody over a blip. A Conversation told twice beats one ' +
  'told nothing (#191).'

describe('roma opens no inbound port for Discord', () => {
  it('has no code under src/channels/discord that could receive a request', () => {
    const offenders = discordSources().filter(({ source }) =>
      LISTENS.some((pattern) => pattern.test(source)),
    )

    expect(offenders.map(({ file }) => file)).toEqual([])
  })
})

const LISTENS = [/\bcreateServer\b/, /\.listen\s*\(/, /node:(http|https|http2|net|tls|dgram)\b/]

function discordSources() {
  return sources().filter(({ file }) => file.split(sep).includes('discord'))
}

function person(id: string): Record<string, unknown> {
  return { id, username: `user-${id}`, global_name: `User ${id}` }
}

function flushed(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

afterEach(() => {
  vi.useRealTimers()
})
