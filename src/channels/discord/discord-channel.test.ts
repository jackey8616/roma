import { sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IngressMessage } from '../../channel-adapter.js'
import { readCommand } from '../../commands.js'
import { sessionIdFor } from '../../session-id.js'
import type { Delivery } from '../../transport.js'
import { DiscordAdapter } from './discord-adapter.js'
import type { DiscordEvent, DiscordMessage } from './discord-events.js'
import {
  GatewayTransport,
  INTENTS,
  RECONNECT_CEILING_MS,
  RECONNECT_FLOOR_MS,
  type DiscordLogRecord,
} from './gateway-transport.js'
import { FakeGatewayNetwork } from '../../../test/support/fake-gateway.js'
import { RecordingDiscordApi } from '../../../test/support/recording-discord-api.js'
import { sources } from '../../../test/support/sources.js'

// SEAM 3 — the Discord Channel: a raw Gateway frame goes in and an ingress
// message comes out, with only the socket and the REST call doubled.
//
// **Wider than the Chat seam, deliberately.** It covers the Transport as well as
// the Adapter, because this Transport *decides* things where Chat's only decodes
// an envelope: which channels a guild has, and therefore whether a message is in
// a thread; and what a Quotation says, which costs a round trip. Nothing that
// decides something may sit behind an untested port.
//
// The frames below are **written from Discord's documented shape, not
// captured**. Nothing in this repo can capture one — there is no guild and no
// application — which is the position ADR-0004's first version was in when two of
// its facts turned out to be wrong. The one fact everything here rests on is
// quoted twice in Discord's own reference: *"The created thread and the message
// it was started from will share the same id"*.

const TOKEN = 'a-bot-token'
const GATEWAY = 'wss://gateway.example/?v=10&encoding=json'
const RESUME_GATEWAY = 'wss://resume.example/?v=10&encoding=json'
/** What `HELLO` carries in Discord's own documented example. */
const HEARTBEAT_INTERVAL = 41_250

const ROMA = '100000000000000001'
const CALLER = '200000000000000002'
const SOMEBODY_ELSE = '200000000000000003'
const GUILD = '300000000000000004'
/** One of the guild's own channels: a top-level message here opens a thread. */
const CHANNEL = '400000000000000005'
/** A thread in that channel, which is therefore *not* one of the guild's channels. */
const THREAD = '500000000000000006'
/** A thread nobody has posted in for a day: in the channel list and the thread list alike, absent. */
const ARCHIVED = '500000000000000007'
/** The channel a direct message arrives in, which has no guild at all. */
const DM = '600000000000000008'
const MESSAGE = '700000000000000009'
const QUOTED = '700000000000000010'

const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6

/** Discord's own hello, and the only thing it says. */
const HELLO = { op: 10, d: { heartbeat_interval: HEARTBEAT_INTERVAL } }

/** The dispatch that names roma to itself, and says where a resume goes. */
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

/**
 * The guild's state, as `GUILD_CREATE` carries it.
 *
 * Both lists, because the whole of the classifier is which one it reads:
 * `channels` is *"Channels in the guild"* and `threads` is *"All active
 * threads…"* — so the archived one below is deliberately in neither.
 */
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

/** A message in one of the guild's channels, addressed to roma. */
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

/** A message in a direct message, where being sent one is the whole of the address. */
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

/** An attachment as Discord documents one: a name to print and a link that expires. */
const ATTACHED = {
  id: '800000000000000011',
  filename: 'screenshot.png',
  content_type: 'image/png',
  url: 'https://cdn.example/attachments/screenshot.png?ex=deadbeef',
}

/** roma, with the socket open and nothing said on it yet. */
async function listening() {
  const api = new RecordingDiscordApi()
  const network = new FakeGatewayNetwork()
  const log: DiscordLogRecord[] = []
  const adapter = new DiscordAdapter({ api })
  const transport = new GatewayTransport({
    token: TOKEN,
    url: GATEWAY,
    connect: network.connect,
    api,
    log: (record) => log.push(record),
    // Pinned so a heartbeat lands *on* the interval rather than somewhere inside
    // it. The jitter is Discord asking a fleet of connections not to beat in
    // unison, and roma is one connection.
    jitter: () => 1,
  })

  const deliveries: Delivery<DiscordEvent>[] = []
  const read: IngressMessage[] = []
  await transport.receive(async (delivery) => {
    deliveries.push(delivery)
    const message = adapter.toIngress(delivery.event)
    if (message !== null) read.push(message)
    await delivery.ack()
  })

  return {
    api,
    network,
    log,
    adapter,
    transport,
    deliveries,
    read,
    /** What the Core was handed last, or null where it was handed nothing. */
    get last(): IngressMessage | null {
      return read.at(-1) ?? null
    },
    /** Push one frame, and let the completion behind it finish. */
    async take(frame: unknown): Promise<void> {
      network.socket.push(frame)
      await flushed()
    },
  }
}

/** roma, identified, with the guild's channel list in hand. */
async function connected(channels: readonly string[] = [CHANNEL]) {
  const channel = await listening()
  await channel.take(HELLO)
  await channel.take(ready())
  await channel.take(guildCreate(channels))
  return channel
}

/** One message, delivered and read. */
async function messaged(message: DiscordMessage, channels: readonly string[] = [CHANNEL]) {
  const channel = await connected(channels)
  await channel.take(dispatch('MESSAGE_CREATE', message))
  return channel
}

describe('which Conversation a Discord message belongs to', () => {
  // Row one of ADR-0029's table. There is no guild, so there is nothing to
  // classify and nowhere to open a thread: roma replies in place.
  it('is the channel, in a direct message', async () => {
    const channel = await messaged(inDm())

    expect(channel.last?.conversationKey).toBe(DM)
  })

  // Row two. The channel the message arrived in is not one of the guild's, so it
  // is a thread — and a thread is already a place roma can reply in.
  it('is the channel it arrived in, in a thread', async () => {
    const channel = await messaged(addressed({ channel_id: THREAD }))

    expect(channel.last?.conversationKey).toBe(THREAD)
  })

  // Row three, and the one that only works because of the fact quoted twice in
  // Discord's reference: a thread takes the id of the message it was started
  // from. So the key minted here, before any thread exists, is the id the thread
  // will have — no Adapter state, no lookup, and `toIngress` stays synchronous.
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

  // The polarity ADR-0029 chose, and the whole reason it chose it. An archived
  // thread is in neither of the guild's lists: `channels` is complete and
  // `threads` holds only the active ones. A classifier reading the thread list
  // would call this a channel and key it on the message — a Session per message,
  // for ever, in a thread roma is already in.
  it('reads a thread archived out of both of the guild’s lists as a thread', async () => {
    const channel = await messaged(addressed({ channel_id: ARCHIVED }))

    expect(channel.last?.conversationKey).toBe(ARCHIVED)
  })

  // The channel list is kept current over the same socket, at no cost in intents
  // or round trips. A channel made after roma connected is a channel.
  it('learns a channel made after it connected, and forgets a deleted one', async () => {
    const channel = await connected()
    const made = '400000000000000012'

    await channel.take(dispatch('CHANNEL_CREATE', { id: made, guild_id: GUILD, type: 0 }))
    await channel.take(dispatch('MESSAGE_CREATE', addressed({ id: '1', channel_id: made })))
    await channel.take(dispatch('CHANNEL_DELETE', { id: made, guild_id: GUILD, type: 0 }))
    await channel.take(dispatch('MESSAGE_CREATE', addressed({ id: '2', channel_id: made })))

    // Top level while it was a channel, and read as a thread once it was gone —
    // which is the harmless direction, and the only one available for a channel
    // that no longer exists.
    expect(channel.read.map(({ conversationKey }) => conversationKey)).toEqual(['1', made])
  })

  // A thread is never one of the guild's channels, however it is announced.
  it('takes a thread announced on the socket back out of the channel list', async () => {
    const channel = await connected([CHANNEL, THREAD])

    await channel.take(dispatch('THREAD_CREATE', { id: THREAD, guild_id: GUILD, type: 11 }))
    await channel.take(dispatch('MESSAGE_CREATE', addressed({ channel_id: THREAD })))

    expect(channel.last?.conversationKey).toBe(THREAD)
  })
})

// The misclassification itself, built the only way it can honestly arise: a
// thread the guild listed among its own channels. An *active* thread cannot
// produce it — `GUILD_CREATE` names those and roma takes them straight back out
// — so this is the archived one, which is in neither list and therefore free to
// turn up in the wrong one.
describe('every way the classifier can be wrong is the harmless direction', () => {
  // A thread misread as top level. Every message gets a key of its own, so the
  // context resets visibly — and two people talking in it never share a Session,
  // which is the half that matters: nothing leaks between Callers. What is *not*
  // asserted here is the reply arriving in `channel_id` after Discord refuses a
  // thread inside a thread — that is outbound, and #180's.
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

  // The place a reply belongs is on the event whichever way the classifier went,
  // which is what makes the fallback ADR-0029 describes possible at all: roma is
  // refused the thread, and posts in `channel_id`, which is where the reply
  // belonged. Reading it back is stage 3's (#180); carrying it is this stage's.
  it('carries the channel the message arrived in, whatever the key says', async () => {
    const channel = await connected([CHANNEL, ARCHIVED])

    await channel.take(dispatch('MESSAGE_CREATE', addressed({ channel_id: ARCHIVED })))

    expect(channel.deliveries.at(-1)?.event.message['channel_id']).toBe(ARCHIVED)
    expect(channel.last?.conversationKey).toBe(MESSAGE)
  })
})

describe('what roma reads out of a message', () => {
  // Discord does not strip the mention, unlike Chat's `argumentText`. Left in,
  // `readCommand` matches nothing and `/stop` becomes a paid Task — the exact
  // fault ADR-0023 exists to close, arriving by a different door.
  it('strips its own mention, so a Command survives as one', async () => {
    const channel = await messaged(addressed({ content: `<@${ROMA}> /stop` }))

    expect(channel.last?.text).toBe('/stop')
    expect(readCommand(channel.last?.text ?? '')).toEqual({ command: 'stop', argument: null })
  })

  it('strips the older spelling of the same mention', async () => {
    const channel = await messaged(addressed({ content: `<@!${ROMA}> /clear` }))

    expect(readCommand(channel.last?.text ?? '')).toEqual({ command: 'clear', argument: null })
  })

  // Only roma's own. Every other mention is content somebody typed, and a reader
  // that removed those would be editing what the model is asked about.
  it('leaves everybody else’s mention where it was', async () => {
    const channel = await messaged(
      addressed({ content: `<@${ROMA}> ask <@${SOMEBODY_ELSE}> about the outage` }),
    )

    expect(channel.last?.text).toBe(`ask <@${SOMEBODY_ELSE}> about the outage`)
  })

  // Answering an app is how two bots in one channel talk to each other until
  // somebody notices. roma's own messages carry the same flag, which is what
  // stops it answering itself.
  it('ignores another app, and says so rather than saying nothing', async () => {
    const channel = await messaged(addressed({ author: { id: SOMEBODY_ELSE, bot: true } }))

    expect(channel.read).toEqual([])
    expect(channel.deliveries).toHaveLength(1)
  })

  it('ignores a message posted through a webhook', async () => {
    const channel = await messaged(addressed({ webhook_id: '900000000000000013' }))

    expect(channel.read).toEqual([])
  })

  // The price ADR-0029 accepts for asking for no privileged intent: in a guild,
  // every message must address roma. Without the intent this one arrives empty
  // anyway — the decision is made here rather than left to a side effect of it.
  it('ignores a guild message that did not address it', async () => {
    const channel = await messaged(addressed({ content: 'what did you all think?', mentions: [] }))

    expect(channel.read).toEqual([])
  })

  // A reply-ping addresses roma without the mention appearing in the text, which
  // is why both readings are made.
  it('answers a message that names it in the mentions and not in the words', async () => {
    const channel = await messaged(addressed({ content: 'and this one?' }))

    expect(channel.last?.text).toBe('and this one?')
  })

  it('answers a direct message with no mention in it at all', async () => {
    const channel = await messaged(inDm())

    expect(channel.last?.text).toBe('hello')
  })

  // A bare mention with nothing after it. Answering would spend a Turn asking
  // Claude Code what to make of an empty message.
  it('reads a message with nothing in it as not a request', async () => {
    const channel = await messaged(addressed({ content: `<@${ROMA}>` }))

    expect(channel.read).toEqual([])
  })

  // Both halves, wanted for different things: the id is what an Audit Record is
  // filed under and what tells two people of the same name apart, and the
  // display name is the half a person reads (ADR-0009). Neither is parsed.
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
  // Redeemed late, as every Enclosure is: the bytes are fetched once the Core
  // knows the Session and knows they are wanted, which is after Parking and
  // after any `/stop` (ADR-0011).
  it('takes an attachment as an Enclosure, and fetches nothing until it is redeemed', async () => {
    const channel = await messaged(addressed({ attachments: [ATTACHED] }))
    channel.api.holdsAttachment(ATTACHED.url, 'the bytes')

    const enclosure = channel.last?.enclosures[0]
    expect(enclosure).toMatchObject({ name: 'screenshot.png', from: null })
    expect(channel.api.downloads).toEqual([])

    expect(new TextDecoder().decode(await enclosure?.redeem())).toBe('the bytes')
    expect(channel.api.downloads).toEqual([ATTACHED.url])
  })

  // A link that has expired is the ordinary case rather than an edge one: a Task
  // parked for the Shared Window can wait hours, and `redeem` is allowed to
  // reject for exactly this (#173).
  it('lets a redeem fail where the link has expired', async () => {
    const channel = await messaged(addressed({ attachments: [ATTACHED] }))

    await expect(channel.last?.enclosures[0]?.redeem()).rejects.toThrow(/no content/)
  })

  // The same rule Chat has: nothing in it is not a request, and a pasted
  // screenshot with no words is the most ordinary thing there is to send.
  it('reads a message with an attachment and no words as a request', async () => {
    const channel = await messaged(inDm({ content: '', attachments: [ATTACHED] }))

    expect(channel.last).toMatchObject({ text: '', enclosures: [{ name: 'screenshot.png' }] })
  })
})

describe('a Quotation is completed before the Core sees it', () => {
  /** A reply, whose quoted message arrives empty because roma has no content intent. */
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

  // The fallback and not supporting Quotations at all are one code path, which
  // is what makes the unverified premise behind the fetch a question rather than
  // a risk (#170). The message still arrives — what is lost is the *this* in
  // "what do you think about this?", and the operator is told.
  it('hands over no Quotation where the fetch is refused, and says so', async () => {
    const channel = await messaged(replying)

    expect(channel.last?.quotation).toBeNull()
    expect(channel.last?.text).toBe('what do you think about this?')
    expect(channel.log).toContainEqual({ event: 'quote-unfetched', reason: expect.any(String) })
  })

  // A forward carries its own snapshot and excludes the author, so the Quotation
  // has none. **Never invented**: unattributed words in front of the model are
  // read as the Caller's own, and a made-up attribution is worse than none.
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

  // Pointing at a message is what a chat window is for, so a message that quotes
  // one and says nothing is still a request (ADR-0021).
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
  // The classifier is unanswerable until the guild's channel list has arrived: a
  // channel roma has not been told about is indistinguishable from a thread. So
  // the message waits — and there is no queue behind this Transport to wait in,
  // which is why the waiting is roma's own.
  it('holds a message that arrives before the guild’s channels, then reads it right', async () => {
    const channel = await listening()
    await channel.take(HELLO)
    await channel.take(ready())

    await channel.take(dispatch('MESSAGE_CREATE', addressed()))
    expect(channel.deliveries).toEqual([])
    expect(channel.log).toContainEqual({ event: 'gateway-held', guildId: GUILD })

    await channel.take(guildCreate())

    // Top level, which is the answer only the channel list can give. Read on
    // arrival it would have been a thread — a Session per message, in the place
    // people talk in most.
    expect(channel.last?.conversationKey).toBe(MESSAGE)
  })

  // A direct message needs no guild, so nothing holds it up past `READY`.
  it('holds a direct message only until it knows who it is', async () => {
    const channel = await listening()

    await channel.take(dispatch('MESSAGE_CREATE', inDm()))
    expect(channel.deliveries).toEqual([])

    await channel.take(HELLO)
    await channel.take(ready())

    expect(channel.last?.conversationKey).toBe(DM)
  })
})

describe('the connection roma holds open', () => {
  it('identifies with the guild and message intents, and no privileged one', async () => {
    const channel = await listening()
    await channel.take(HELLO)

    const [identify] = channel.network.socket.sentWith(OP_IDENTIFY)
    expect(identify?.['d']).toMatchObject({ token: TOKEN, intents: INTENTS })
    // `MESSAGE_CONTENT`, the one roma refuses. It is a toggle in a developer
    // portal where nothing versions it and no test can see it, and its
    // exceptions are exactly the messages roma answers (ADR-0029).
    expect(INTENTS & (1 << 15)).toBe(0)
  })

  it('heartbeats on the interval Discord named, carrying the last event it saw', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await listening()
    await channel.take(HELLO)
    await channel.take(ready(7))

    expect(channel.network.socket.sentWith(OP_HEARTBEAT)).toEqual([])
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL)

    // The sequence is what a resume asks to be replayed from, so a heartbeat
    // that carried the wrong one would lose exactly the events roma missed.
    expect(channel.network.socket.sentWith(OP_HEARTBEAT)).toEqual([{ op: OP_HEARTBEAT, d: 7 }])

    // Discord answers every one of them, and the next beat only goes out
    // because this arrived — see the connection roma gives up on below.
    await channel.take({ op: 11 })
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL)
    expect(channel.network.socket.sentWith(OP_HEARTBEAT)).toHaveLength(2)
  })

  // A socket that stops answering heartbeats is open and dead. Left alone roma
  // looks healthy and answers nobody, which is the one failure nothing else here
  // can see.
  it('gives up on a connection that stopped answering, and resumes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await listening()
    await channel.take(HELLO)
    await channel.take(ready())

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL)
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL)

    expect(channel.network.sockets[0]?.closedWith).toBe(4000)
    vi.advanceTimersByTime(RECONNECT_FLOOR_MS)
    expect(channel.network.sockets).toHaveLength(2)
  })

  // Closing a socket is a handshake, so the close roma asked for arrives after
  // roma has already reconnected. Read as the *current* connection ending, it
  // opens a second one on top of the live one — and roma holds two Gateways,
  // both delivering everything.
  it('ignores a close from a connection it has already left behind', async () => {
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

    expect(channel.network.sockets).toHaveLength(2)
  })

  // Resuming is what makes a dropped connection a gap rather than a loss: the
  // session and the sequence together are what Discord replays from.
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

  // The property the whole of settling rests on. A resumed session replays what
  // roma missed, so the same message can arrive twice — and `Ingress.take` tells
  // that from a second message saying the same words by the Delivery's id, which
  // is the event's own snowflake and nothing minted here.
  it('names a replayed message the same both times', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await connected()
    await channel.take(dispatch('MESSAGE_CREATE', addressed()))

    channel.network.socket.hangUp(1006)
    vi.advanceTimersByTime(RECONNECT_FLOOR_MS)
    channel.network.socket.push(HELLO)
    await channel.take(dispatch('MESSAGE_CREATE', addressed()))

    expect(channel.deliveries.map(({ id }) => id)).toEqual([MESSAGE, MESSAGE])
  })

  // Both no-ops, and #178 is what makes that a supported shape rather than a
  // lie. A socket has nowhere to hand a Delivery back to, so roma says nothing
  // on the wire either way (ADR-0028).
  it('settles a Delivery by saying nothing at all', async () => {
    const channel = await messaged(addressed())
    const before = channel.network.socket.sent.length
    const delivery = channel.deliveries.at(-1)

    expect(() => delivery?.ack()).not.toThrow()
    expect(() => delivery?.nack()).not.toThrow()
    expect(channel.network.socket.sent).toHaveLength(before)
  })

  // Dropped, because there is nowhere to hand it back to — so this line is the
  // only trace it leaves, and the difference between "Discord changed shape" and
  // "nobody is talking to roma".
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

  it('writes down a socket fault rather than throwing it', async () => {
    const channel = await listening()

    expect(() => channel.network.socket.fail(new Error('connection reset'))).not.toThrow()
    expect(channel.log).toContainEqual({ event: 'gateway-error', reason: 'connection reset' })
  })

  // A bad token and a disallowed intent are deployment facts: another attempt
  // fails identically, and attempts that cannot succeed are what earn a ban on
  // the whole API. So roma stops, and says why — nothing else would.
  it('stops reconnecting when Discord refuses the connection for good', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await listening()
    await channel.take(HELLO)

    channel.network.socket.hangUp(4004)
    vi.advanceTimersByTime(RECONNECT_CEILING_MS)

    expect(channel.log).toContainEqual({ event: 'gateway-refused', code: 4004 })
    expect(channel.network.sockets).toHaveLength(1)
  })

  // Where the session is gone rather than the connection, roma identifies afresh
  // instead of asking to be replayed into a session that no longer exists.
  it('identifies afresh when the session is invalidated', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const channel = await listening()
    await channel.take(HELLO)
    await channel.take(ready())

    await channel.take({ op: 9, d: false })
    vi.advanceTimersByTime(RECONNECT_FLOOR_MS)
    channel.network.socket.push(HELLO)

    expect(channel.network.socket.sentWith(OP_IDENTIFY)).toHaveLength(1)
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

describe('what this Channel cannot do yet', () => {
  // Stage 2 is inbound only. Rejecting is the honest answer to `deliver`'s own
  // sentence — "Rejecting means it reached nobody" — and a silent no-op would be
  // the lie: the Core would take it for a Conversation that had been told.
  it('refuses an outbound instruction rather than pretending to post it', async () => {
    const { adapter } = await listening()

    await expect(
      adapter.deliver({
        kind: 'result',
        text: 'done',
        taskId: 'task-1',
        conversationKey: MESSAGE,
        caller: CALLER,
        callerName: 'Ada',
      }),
    ).rejects.toThrow(/#180/)
  })
})

describe('roma opens no inbound port for Discord', () => {
  // ADR-0003's "ingress is a queue, not a webhook" survives here by a different
  // route: the Gateway is a socket roma opens *outward*, and interactions arrive
  // on it too — the HTTP endpoint is the other half of a mutually exclusive pair
  // and roma registers none. A guard rather than a comment, because the file
  // that would break it is one somebody writes while adding buttons.
  it('has no code under src/channels/discord that could receive a request', () => {
    const offenders = discordSources().filter(({ source }) =>
      LISTENS.some((pattern) => pattern.test(source)),
    )

    expect(offenders.map(({ file }) => file)).toEqual([])
  })
})

/** Every way this directory could start accepting connections instead of making one. */
const LISTENS = [/\bcreateServer\b/, /\.listen\s*\(/, /node:(http|https|http2|net|tls|dgram)\b/]

function discordSources() {
  return sources().filter(({ file }) => file.split(sep).includes('discord'))
}

/** One person, as Discord names them on a message. */
function person(id: string): Record<string, unknown> {
  return { id, username: `user-${id}`, global_name: `User ${id}` }
}

/** Let the completion behind a message, which runs detached from the frame, finish. */
function flushed(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

afterEach(() => {
  vi.useRealTimers()
})
