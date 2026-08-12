import { sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IngressMessage, OutboundInstruction } from '../../channel-adapter.js'
import { readCommand } from '../../commands.js'
import { EFFORT_NAMES } from '../../effort-menu.js'
import { MENU_NAMES } from '../../model-menu.js'
import { sessionIdFor } from '../../session-id.js'
import type { Delivery } from '../../transport.js'
import { ATTEMPTS, DiscordAdapter, RETRY_CEILING_MS, RETRY_FLOOR_MS } from './discord-adapter.js'
import { DiscordRefusal, type DiscordButton } from './discord-api.js'
import { MAX_CUSTOM_ID, type DiscordEvent, type DiscordMessage } from './discord-events.js'
import {
  GatewayTransport,
  INTENTS,
  RECONNECT_CEILING_MS,
  RECONNECT_FLOOR_MS,
  type DiscordLogRecord,
} from './gateway-transport.js'
import { MAX_TEXT, OVERFLOW_BUTTON } from './render.js'
import { FakeGatewayNetwork } from '../../../test/support/fake-gateway.js'
import { recordedStream } from '../../../test/support/recorded-stream.js'
import {
  RecordingDiscordApi,
  type DiscordCall,
} from '../../../test/support/recording-discord-api.js'
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
/** A forum channel: one of the guild's own, and every message in it is inside a post. */
const FORUM = '400000000000000016'
/** The channel a direct message arrives in, which has no guild at all. */
const DM = '600000000000000008'
const MESSAGE = '700000000000000009'
const QUOTED = '700000000000000010'
/** A card roma posted, which is the message a press arrives carrying. */
const CARD = '700000000000000017'
/** One press, which is its own event and never the card's. */
const INTERACTION = '900000000000000018'
const INTERACTION_TOKEN = 'an-interaction-token'

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

/**
 * roma's own card, in the thread it opened.
 *
 * Authored by an application, which is what a press event always carries — and
 * the reason the press gets a reader of its own rather than a branch inside the
 * message reader (ADR-0023).
 */
function card(overrides: Record<string, unknown> = {}): DiscordMessage {
  return {
    id: CARD,
    channel_id: MESSAGE,
    guild_id: GUILD,
    author: { id: ROMA, username: 'roma', bot: true },
    content: 'You can choose: opus, sonnet, haiku, default.',
    ...overrides,
  }
}

/** A press on one button, as Discord delivers one over the same socket messages arrive on. */
function press(customId: string, overrides: Record<string, unknown> = {}): unknown {
  return dispatch('INTERACTION_CREATE', {
    id: INTERACTION,
    token: INTERACTION_TOKEN,
    // `MESSAGE_COMPONENT`. The other kind is an application command, and roma
    // registers none.
    type: 3,
    application_id: ROMA,
    channel_id: MESSAGE,
    guild_id: GUILD,
    // Whoever pressed, where a guild puts them. Never the card's author, which
    // is roma.
    member: { user: { id: CALLER, username: 'ada', global_name: 'Ada' } },
    data: { custom_id: customId, component_type: 2 },
    message: card(),
    ...overrides,
  })
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
  // Every wait roma sat through, in order, spent instantly. What a retry policy
  // does that a test can see is *how long it waited before trying again*, so the
  // clock is the thing that has to be recorded rather than mocked away.
  const waits: number[] = []
  const adapter = new DiscordAdapter({
    api,
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
    // Pinned so a heartbeat lands *on* the interval rather than somewhere inside
    // it. The jitter is Discord asking a fleet of connections not to beat in
    // unison, and roma is one connection.
    jitter: () => 1,
  })

  const deliveries: Delivery<DiscordEvent>[] = []
  const read: IngressMessage[] = []
  // What roma had already said to Discord at the moment each Delivery arrived.
  // The only way to assert that the acknowledgement went out *before* the event
  // was handed on, which is the whole of the three-second deadline: read after
  // the fact, both orders leave the same two calls in the same list.
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
    /** The buttons on the last message roma posted, in the order it posted them. */
    get buttons(): readonly DiscordButton[] {
      return api.messages.at(-1)?.posted.buttons ?? []
    },
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

/**
 * What an instruction says, with the address taken off.
 *
 * Distributed over the union rather than `Partial<…>`, so that a test asking for
 * a `result` with no text is a type error here rather than a passing test of
 * something the Core cannot send.
 */
type Outcome<T> = T extends unknown
  ? Omit<T, 'taskId' | 'conversationKey' | 'caller' | 'callerName'>
  : never

/** An instruction addressed to one Conversation, as the Core would send it. */
function to(
  conversationKey: string,
  outcome: Outcome<OutboundInstruction>,
  taskId = 'task-1',
  caller = CALLER,
  callerName: string | null = 'Ada',
): OutboundInstruction {
  return { ...outcome, taskId, conversationKey, caller, callerName }
}

/**
 * A refusal as `HttpDiscordApi` would have built one from a response.
 *
 * The two fields a retry acts on and nothing else — a status, and however long
 * Discord's own headers asked roma to wait.
 */
function refusal(status: number, retryAfterMs: number | null = null): DiscordRefusal {
  return new DiscordRefusal(`Discord answered ${status}`, status, retryAfterMs)
}

/**
 * A Menu as the Core sends one, over the real Menu rather than a copy of it.
 *
 * The names are what a button is labelled with *and* what a press comes back
 * saying, so a test spelling its own would be asserting that roma agrees with
 * the test rather than that a Menu survives the round trip.
 */
function choice(
  chooses: 'model' | 'effort',
  options: readonly string[],
  text = `You can choose: ${options.join(', ')}.`,
): Outcome<OutboundInstruction> {
  return { kind: 'choice', text, chooses, options, refused: null }
}

/**
 * The `custom_id` off a button roma actually posted.
 *
 * Never a string a test wrote: a button carrying something roma's own reader
 * cannot read back is the failure this whole area exists to catch, and it is
 * invisible to a press built out of a literal.
 */
function customIdFor(buttons: readonly DiscordButton[], label: string): string {
  const button = buttons.find((candidate) => candidate.label === label)
  if (button === undefined) throw new Error(`no button labelled ${label}`)
  return button.customId
}

/** The complete answer of the recorded 72-second generating Turn. */
function recordedAnswer(): string {
  const [finished] = recordedStream('generation-partial-messages')
    .turn(1)
    .filter((event) => event.type === 'result')
  return String(finished?.['result'] ?? '')
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
  // which is the half that matters: nothing leaks between Callers. The reply
  // still arrives, in `channel_id`, once Discord refuses a thread inside a
  // thread — that half is asserted under "where an answer goes".
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
  // belonged. Carrying it is what this asserts; using it is the Adapter's.
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

// The outbound half, driven the way the inbound half is: a real Gateway frame
// goes in first, because everything an answer needs beyond the Conversation Key
// — the message it replies to, the channel a thread has to be opened in — is
// learned from the event and cannot be learned anywhere else.
describe('where an answer goes', () => {
  // Row three of ADR-0029's table, completed. The key is the message's own id
  // because that is the id the thread will take, and this is the moment the
  // thread has to come to exist.
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

  // Rows one and two. Both are already a place roma can speak, so there is
  // nothing to open — and asking Discord for a thread inside a thread would be a
  // refused call roma spends its invalid-request budget on for nothing.
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

  // **A forum needs no special case, and this is the proof rather than the
  // claim.** The Start Thread route does not work on a forum or media channel at
  // all — and it is never reached for one, because every message in a forum is
  // inside a post, a post is a thread, and a thread is not among the guild's
  // channels. So the classifier has already routed it to a reply in place.
  it('opens no thread in a forum, because the classifier already replied in place', async () => {
    const post = '500000000000000015'
    const channel = await messaged(addressed({ channel_id: post }), [CHANNEL, FORUM])

    await channel.adapter.deliver(to(post, { kind: 'result', text: 'the answer' }))

    expect(channel.last?.conversationKey).toBe(post)
    expect(channel.api.threads).toEqual([])
    expect(channel.api.messages[0]?.posted.channel).toBe(post)
  })

  // One thread for a Conversation, however much roma says in it. The key names
  // the thread once it exists, so nothing has to be remembered to find it again
  // — which is also what makes a restart mid-Conversation harmless.
  it('opens one thread however many messages a Task posts', async () => {
    const channel = await messaged(addressed())

    await channel.adapter.deliver(to(MESSAGE, { kind: 'progress', progress: { phase: 'working' } }))
    await channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

    expect(channel.api.threads).toHaveLength(1)
    expect(channel.api.messages.map(({ posted }) => posted.channel)).toEqual([MESSAGE, MESSAGE])
  })

  // The fallback ADR-0029 calls the harmless direction, and the property #179
  // carried the channel id for. roma may hold no `CREATE_PUBLIC_THREADS`, the
  // channel may be one the route does not work on, or the classifier may have
  // read a thread as top level — in every one of them the reply belongs in the
  // channel the message arrived in, and only the Session is in the wrong place.
  it('falls back to the channel the message arrived in when a thread is refused', async () => {
    const channel = await messaged(addressed())
    channel.api.failEvery('startThread', refusal(403))

    await channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

    expect(channel.api.messages[0]?.posted.channel).toBe(CHANNEL)
  })

  // Remembered, so that the rest of a Task lands where its first message did. A
  // second attempt would also be a second 403, and 403s are what the ban roma
  // must not earn is counted in.
  it('keeps answering where it fell back to, without asking again', async () => {
    const channel = await messaged(addressed())
    channel.api.failEvery('startThread', refusal(403))

    await channel.adapter.deliver(to(MESSAGE, { kind: 'progress', progress: { phase: 'working' } }))
    await channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

    expect(channel.api.threads).toHaveLength(1)
    expect(channel.api.messages.map(({ posted }) => posted.channel)).toEqual([CHANNEL, CHANNEL])
  })

  // The Core cannot absorb this one: an instruction that reached nobody looks,
  // from the Conversation, exactly like a message that was never received.
  it('does not swallow a refusal it has run out of attempts on', async () => {
    const channel = await messaged(inDm())
    channel.api.failEvery('post', refusal(403))

    await expect(
      channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' })),
    ).rejects.toThrow(/403/)
  })
})

/**
 * ADR-0029's outbound decision: the Caller is addressed with Discord's own
 * reply, on the first message and no other.
 */
describe('addressing the person who asked', () => {
  it('replies to the Caller’s message on the first piece and on nothing else', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'word '.repeat(2000) }))

    const replies = channel.api.messages.map(({ posted }) => posted.replyTo)
    expect(replies.length).toBeGreaterThan(2)
    expect(replies[0]).toBe(MESSAGE)
    expect(replies.slice(1).every((replyTo) => replyTo === null)).toBe(true)
  })

  // Nothing in the words, which is the whole difference from Chat: a mention
  // spends characters out of a limit half the size, and Discord has a form for
  // this that costs none.
  it('says nothing in the text about who it is for', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(channel.api.texts).toEqual(['the answer'])
  })

  // A thread is many people sharing one Conversation, and two Tasks can be in
  // flight in it at once. Keyed on the Conversation alone, Ada's answer would
  // reply to whichever question arrived last — which is Bob's (ADR-0009).
  it('answers each of a thread’s two Callers on their own message', async () => {
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

    expect(channel.api.messages.map(({ posted }) => posted.replyTo)).toEqual(['ada-1', 'bob-1'])
  })
})

describe('an answer longer than Discord will take', () => {
  // 17706 characters is what the recorded generating Turn produced, and Discord
  // refuses anything over 2000. Without this the longest answers — the ones
  // worth having — would be the ones that never arrive.
  //
  // **Twelve, and ADR-0029 predicted nine.** Nine is 17706 divided by 2000 and
  // is what a splitter that cut mid-word would produce; twelve is what the
  // paragraph rule costs, because a window whose last blank line falls just past
  // halfway spends the rest of itself on nothing. The rule is the decision and
  // the count is its consequence, so the count is asserted here rather than
  // written down anywhere that could go on claiming nine.
  it('splits the recorded 17,706-character Turn into twelve messages', async () => {
    const channel = await messaged(inDm())
    const answer = recordedAnswer()

    await channel.adapter.deliver(to(DM, { kind: 'result', text: answer }))

    expect(answer).toHaveLength(17706)
    expect(channel.api.messages).toHaveLength(12)
    for (const message of channel.api.messages) {
      expect(message.text.length).toBeLessThanOrEqual(MAX_TEXT)
    }
    // Nothing dropped and nothing duplicated: the words arrive in order and
    // whole, which is the only thing a split may not cost.
    expect(channel.api.texts.join('\n\n').replace(/\s+/g, ' ')).toBe(answer.replace(/\s+/g, ' '))
  })

  // At a blank line where there is one. Cutting mid-word makes a long answer
  // read as corrupted rather than as continued.
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

  // A failed Turn's reason is the Turn's own text, which has no more of a length
  // limit than an answer does. Posted whole, Discord refuses it and the
  // Conversation is told nothing at all about a Task that is already dead.
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

  it('says something even when a Turn produced no text at all', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'result', text: '' }))

    expect(channel.api.messages).toHaveLength(1)
    expect(channel.api.texts[0]).not.toBe('')
  })
})

describe('the acknowledgement', () => {
  // One message, edited. ADR-0029 declares message mutation, so progress
  // reporting runs in its full ADR-0003 form — and a renderer that posted per
  // update would make a Task that ran for five minutes into sixty messages
  // burying the Conversation it is reporting on.
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

  // The rule ADR-0003 makes unconditional, and Discord is where it pays most:
  // its search reads message content and no part of an edited-over
  // acknowledgement is a thing anybody can quote-reply to months later.
  it('is never what the result is written into', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } }))
    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(channel.api.calls).toEqual(['post', 'post'])
    expect(channel.api.texts).toEqual(['Working…', 'the answer'])
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

  // Not an ending, the way a block is not: it arrives mid-Task and the Task goes
  // on to whatever ending it has. Forgetting the acknowledgement here would
  // strand the message the person is watching and post a second one under it.
  it('keeps the one it was mutating for a message that is not an ending', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } }))
    await channel.adapter.deliver(to(DM, { kind: 'context-full' }))
    await channel.adapter.deliver(
      to(DM, { kind: 'progress', progress: { phase: 'writing', characters: 14 } }),
    )

    expect(channel.api.calls).toEqual(['post', 'post', 'edit'])
  })

  // A post that failed left no message to edit. Remembered anyway, every later
  // update for that Task would try to edit an id that never existed — so one
  // Discord hiccup would silence the acknowledgement for the rest of a Task that
  // is running perfectly well.
  it('tries again after a post that failed, rather than editing nothing', async () => {
    const channel = await messaged(inDm())
    channel.api.failNext('post', refusal(403))

    await expect(
      channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'working' } })),
    ).rejects.toThrow(/403/)
    await channel.adapter.deliver(
      to(DM, { kind: 'progress', progress: { phase: 'tool', tool: 'awk' } }),
    )

    expect(channel.api.calls).toEqual(['post', 'post'])
    expect(channel.api.texts).toEqual(['Running awk…'])
  })

  // The one phase whose length roma does not control: a tool is named by Claude
  // Code's own description of it, which is the command itself. It is cut to
  // something that can be read at a glance, well before Discord's limit is in
  // question — a message edited every few seconds is not where a thousand
  // characters of shell belongs.
  it('quotes only as much of a tool command as can be read at a glance', async () => {
    const channel = await messaged(inDm())
    const tool = `awk ${'-v x=1 '.repeat(1000)}`

    await channel.adapter.deliver(to(DM, { kind: 'progress', progress: { phase: 'tool', tool } }))

    const text = channel.api.texts[0] ?? ''
    expect(text.length).toBe('Running '.length + 120 + '…'.length)
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT)
    // The beginning is what names the command, so it is the end that goes.
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

  // Plainly that quota is spent, with the reset time the event gave — and that
  // the Task is kept, because told only that quota is spent people send the
  // message again, which is the behaviour the acknowledgement exists to prevent.
  // Nothing in the words about the offer: that is the button below, and a
  // sentence beside it would have to name a Command roma never had.
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

  // The one place roma knows an exit the person cannot guess, said as the
  // consequence rather than the cause — two codes arrive here and only one of
  // them is a thread that got too long.
  it('names /clear when the context cannot be reduced any further', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'context-full' }))

    expect(channel.api.texts).toEqual([
      'Claude cannot shorten this conversation any further, so it cannot take another ' +
        'message. Send /clear to start a fresh session — nothing from this one carries over.',
    ])
  })

  // The words are the whole answer whether or not anything draws them, which is
  // what lets a Channel ignore `options` and be *correct* rather than degraded
  // (ADR-0023). The buttons under them are the shortcut, asserted below.
  it('posts a Menu as the words it already is', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(
      to(DM, {
        kind: 'choice',
        text: 'This conversation is on sonnet (claude-sonnet-5). You can choose: opus, sonnet, haiku, default.',
        chooses: 'model',
        options: ['opus', 'sonnet', 'haiku', 'default'],
        refused: null,
      }),
    )

    expect(channel.api.texts).toEqual([
      'This conversation is on sonnet (claude-sonnet-5). You can choose: opus, sonnet, haiku, default.',
    ])
  })

  // ADR-0002 requires the spend in the reply, and its own message rather than
  // appended to the answer: the answer is what gets quoted months later, and a
  // price tag inside it would be quoted with it.
  it('posts the answer and then what an Overflow Turn cost', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'done', overflowCostUsd: 0.42 }))

    expect(channel.api.texts).toEqual(['done', 'Ran on metered billing: $0.42.'])
  })

  // "$0.00" would report money as free, which is the one claim the Audit Record
  // refuses to make about a Turn nothing priced.
  it('does not price a Turn nothing priced', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'done', overflowCostUsd: null }))

    expect(channel.api.texts).toEqual([
      'done',
      'Ran on metered billing. What it cost was never reported.',
    ])
  })

  it('declares message mutation and a stable Conversation Key', async () => {
    const { adapter } = await listening()

    expect(adapter.capabilities).toEqual({ messageMutation: true, stableConversationKey: true })
  })

  // ADR-0024: an Opening is a reply, sent before the Acknowledgement of the
  // message that prompted it. On this Channel it is also what opens the thread —
  // so the first thing said in a Session is the first thing in the thread, and
  // the acknowledgement lands underneath it rather than in the parent channel.
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

/**
 * ADR-0023 applied to Discord, unchanged: **a press is a message the Caller did
 * not have to type.** The button carries the Command, the Adapter reads it into
 * an ordinary Ingress Message, and it travels the path a typed Command travels
 * — no new Core entrance, no new `ChannelAdapter` method, no new authority to
 * scope, and nothing remembered between posting a card and its being pressed.
 */
describe('a Menu, out as buttons and back as a press', () => {
  it('draws one button per option, in the order the Menu lists them', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))

    expect(channel.buttons.map(({ label }) => label)).toEqual(MENU_NAMES)
    expect(MENU_NAMES).toEqual(['opus', 'sonnet', 'haiku', 'default'])
  })

  // Six, which is one more than an action row holds — so this is the case that
  // proves a Menu is not bounded by a row. Where the second row starts is
  // `http-discord-api.test.ts`'s, because it is a fact about the payload.
  it('draws the whole Effort Menu, past the width of one row', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, choice('effort', EFFORT_NAMES)))

    expect(channel.buttons.map(({ label }) => label)).toEqual(EFFORT_NAMES)
    expect(EFFORT_NAMES.length).toBeGreaterThan(5)
  })

  // *"1-100 characters"*, and being over it is a message Discord refuses whole —
  // a Menu nobody is shown, with nothing in the log about it. Asserted rather
  // than reasoned about, because what goes in one is a Conversation Key roma does
  // not choose the length of.
  it('spends a custom_id Discord will take', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(to(DM, choice('effort', EFFORT_NAMES)))
    await channel.adapter.deliver(
      to(DM, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: true }),
    )

    for (const { customId } of channel.api.messages.flatMap(({ posted }) => posted.buttons)) {
      expect(customId.length).toBeGreaterThanOrEqual(1)
      expect(customId.length).toBeLessThanOrEqual(MAX_CUSTOM_ID)
    }
  })

  // The whole of the design in one assertion: what comes back is the message the
  // Caller would have typed, and `readCommand` reads it as the Command it is. A
  // name that did not survive that round trip would be a button that produces a
  // billable Task — which is why the invariant is driven over the real Menus in
  // `commands.test.ts` rather than restated here.
  it('reads a press as the message the Caller would have typed', async () => {
    const channel = await messaged(inDm())
    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))

    await channel.take(press(customIdFor(channel.buttons, 'opus')))

    expect(channel.last).toMatchObject({ text: '/model opus', caller: CALLER, callerName: 'Ada' })
    expect(readCommand(channel.last?.text ?? '')).toEqual({ command: 'model', argument: 'opus' })
  })

  // The Conversation Key is on the button, so a press answers the Conversation
  // the card was posted about rather than the one the card happens to sit in.
  it('carries the Conversation Key the card was posted for', async () => {
    const channel = await messaged(addressed())
    await channel.adapter.deliver(to(MESSAGE, choice('effort', EFFORT_NAMES)))

    await channel.take(press(customIdFor(channel.buttons, 'xhigh')))

    expect(channel.last?.conversationKey).toBe(MESSAGE)
  })

  /**
   * **The Discord-specific cousin of ADR-0023's stated failure mode.** roma may
   * be refused the thread a top-level key names, and then the card sits in the
   * parent channel — whose id is not the key. Reading the Conversation off
   * `channel_id` there would answer in a Conversation nobody was ever in, and
   * every press in a guild roma lacks `CREATE_PUBLIC_THREADS` in would be wrong
   * (ADR-0029).
   */
  it('is right about the Conversation even where the card is not in it', async () => {
    const posting = await messaged(addressed())
    posting.api.failEvery('startThread', refusal(403))
    await posting.adapter.deliver(to(MESSAGE, choice('model', MENU_NAMES)))
    expect(posting.api.messages.at(-1)?.posted.channel).toBe(CHANNEL)

    // Pressed at a roma that has never seen the card, because that is the state
    // ADR-0023 claims: nothing is remembered between posting one and its being
    // pressed, so the whole of what a press is answered from is the press.
    const restarted = await connected()
    restarted.api.failEvery('startThread', refusal(403))
    await restarted.take(
      press(customIdFor(posting.buttons, 'haiku'), { message: card({ channel_id: CHANNEL }) }),
    )

    expect(restarted.last?.conversationKey).toBe(MESSAGE)
    expect(sessionIdFor(restarted.last?.conversationKey ?? '')).toBe(sessionIdFor(MESSAGE))
    // And the answer still reaches somebody. The key names a thread that was
    // never opened, so what carries the reply is the channel the *card* is in —
    // which is the whole of why a press is remembered as a message is.
    await restarted.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'Now on haiku.' }))
    expect(restarted.api.messages.at(-1)?.posted.channel).toBe(CHANNEL)
  })

  /**
   * **There is nothing to expire and nothing to sweep** (ADR-0023). The card
   * carries a *message* rather than a decision, so pressing a three-week-old one
   * means send this Command now — which is what typing it now would mean.
   *
   * Driven over an Adapter and a Transport that have never seen the card, which
   * is what a restart between the two leaves behind.
   */
  it('answers a press on a card posted before roma last started', async () => {
    const posting = await messaged(addressed())
    await posting.adapter.deliver(to(MESSAGE, choice('model', MENU_NAMES)))
    const pressed = customIdFor(posting.buttons, 'sonnet')

    const restarted = await connected()
    await restarted.take(press(pressed))

    expect(restarted.last).toMatchObject({ conversationKey: MESSAGE, text: '/model sonnet' })
    // And the answer still reaches the Conversation: the key names the thread
    // once it exists, so a message can only ever have the one and asking again
    // is a success.
    await restarted.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'Now on sonnet.' }))
    expect(restarted.api.messages.at(-1)?.posted.channel).toBe(MESSAGE)
  })

  // The Effort Matrix's third use is the Core's — an `/effort` on a model it says
  // takes none arrives as a `result` rather than a `choice`, so there is no Menu
  // here to suppress and no second reading of the Matrix to disagree with
  // `Core.#effortStranded` (ADR-0023). What the Adapter owes is drawing exactly
  // what it was sent, which is what this asserts from the other side.
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

  // Only where there is something to explain. A Menu long enough to split would
  // otherwise repeat itself under every piece, and the buttons belong under the
  // words that name them.
  it('puts the buttons under the last piece of a split answer and no other', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(
      to(DM, choice('model', MENU_NAMES, `${'word '.repeat(2000)}You can choose:`)),
    )

    const drawn = channel.api.messages.map(({ posted }) => posted.buttons.length)
    expect(drawn.length).toBeGreaterThan(1)
    expect(drawn.slice(0, -1).every((count) => count === 0)).toBe(true)
    expect(drawn.at(-1)).toBe(MENU_NAMES.length)
  })
})

describe('the Overflow offer, out as a button and back as a press', () => {
  // ADR-0002 puts the valve at the moment of blocking rather than in a setting,
  // and the label says what pressing it costs — "Run anyway" would be that
  // decision made by somebody who did not know they were making it.
  it('offers Overflow on the message that reports the block', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(
      to(DM, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: true }),
    )

    expect(channel.buttons.map(({ label }) => label)).toEqual([OVERFLOW_BUTTON])
  })

  // False where the provider says overage is unavailable or roma holds no
  // metered credential. A button that cannot work spends somebody's attention on
  // nothing, and on this Channel it is the only thing they could have pressed.
  it('offers none where the Core says there is none to offer', async () => {
    const channel = await messaged(inDm())

    await channel.adapter.deliver(
      to(DM, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: false }),
    )

    expect(channel.buttons).toEqual([])
  })

  // Named by the Task and never by the Conversation, which can have a second
  // Task blocked behind this one — "the blocked Task here" would spend money on
  // whichever roma looked at first.
  it('takes the offer for the Task it was made about', async () => {
    const channel = await messaged(inDm())
    await channel.adapter.deliver(
      to(DM, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: true }, 'task-7'),
    )

    await channel.take(press(customIdFor(channel.buttons, OVERFLOW_BUTTON)))

    const event = channel.deliveries.at(-1)?.event
    expect(channel.adapter.toOverflowTaken(event as DiscordEvent)).toBe('task-7')
  })

  /**
   * **`Ingress.#workFor` tries `toIngress` first and only calls
   * `toOverflowTaken` where that answered null** (`src/serve.ts`). So the two
   * encodings have to be unambiguous in that order: an Overflow press read as an
   * ingress message would turn taking an offer into a paid Task, and a Menu press
   * read as an Overflow one would spend money on a Task roma never named.
   */
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
})

/**
 * The deadline Chat does not have: *"you must send an initial response within 3
 * seconds of receiving the event. If the 3 second deadline is exceeded, the
 * token will be invalidated"* — and roma's Core takes minutes. This is why
 * ADR-0029 made this Transport a thing that decides rather than a bare port.
 */
describe('a press is acknowledged before anything answers it', () => {
  it('says the press arrived before the event is handed on', async () => {
    const channel = await messaged(inDm())
    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))

    await channel.take(press(customIdFor(channel.buttons, 'opus')))

    expect(channel.api.acknowledged).toEqual([
      { interactionId: INTERACTION, token: INTERACTION_TOKEN },
    ])
    // Already said by the time the receiver was called. Read afterwards, both
    // orders leave the same two calls in the same list.
    expect(channel.saidBefore.at(-1)).toContain('acknowledgePress')
  })

  // `DEFERRED_UPDATE_MESSAGE` and nothing after it: pressing is typing, and
  // typing does not rewrite the message you typed into. What roma sends to say
  // that is `http-discord-api.test.ts`'s; that roma never edits the card is this.
  it('leaves the card exactly as it was', async () => {
    const channel = await messaged(inDm())
    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))
    const before = channel.api.messages.map(({ text, edits }) => ({ text, edits }))

    await channel.take(press(customIdFor(channel.buttons, 'opus')))

    expect(channel.api.calls).not.toContain('edit')
    expect(channel.api.messages.map(({ text, edits }) => ({ text, edits }))).toEqual(before)
  })

  // A press roma could not acknowledge is one Discord marks as failed — and
  // answering it late is better than a Task that stays blocked because nobody
  // could take the offer. Nothing else would say so: the answer arrives, so from
  // the Conversation there is no fault to see.
  it('answers a press it could not acknowledge, and writes down that it could not', async () => {
    const channel = await messaged(inDm())
    channel.api.failEvery('acknowledgePress', refusal(404))
    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))

    await channel.take(press(customIdFor(channel.buttons, 'opus')))

    expect(channel.last).toMatchObject({ text: '/model opus' })
    expect(channel.log).toContainEqual({
      event: 'press-unacknowledged',
      reason: expect.any(String),
    })
  })

  // Two presses on one card are two events, and a Delivery named by the card
  // would make the second look like the first arriving twice — which
  // `Ingress.take` drops while the first is still running.
  it('names a Delivery by the press rather than by the card', async () => {
    const channel = await messaged(inDm())
    await channel.adapter.deliver(to(DM, choice('model', MENU_NAMES)))

    await channel.take(press(customIdFor(channel.buttons, 'opus')))
    await channel.take(press(customIdFor(channel.buttons, 'haiku'), { id: '900000000000000019' }))

    expect(channel.deliveries.slice(-2).map(({ id }) => id)).toEqual([
      INTERACTION,
      '900000000000000019',
    ])
  })

  // roma registers no application commands — ADR-0029 leaves slash commands open
  // and explicitly not as something to add quietly — so an interaction that is
  // not a press is one roma neither answers nor acknowledges.
  it('acknowledges nothing that is not a press on something roma posted', async () => {
    const channel = await messaged(inDm())

    await channel.take(press('choose:model:1:opus', { type: 2 }))

    expect(channel.api.acknowledged).toEqual([])
    expect(channel.deliveries).toHaveLength(1)
  })

  // A press whose `custom_id` roma cannot read is acknowledged all the same —
  // the three seconds are spent whether or not roma understands it — and then
  // answers nothing, which is what an event roma is not meant to answer does.
  it('answers nothing for a custom_id roma never put out', async () => {
    const channel = await messaged(inDm())

    await channel.take(press('something-roma-never-wrote'))

    expect(channel.api.acknowledged).toHaveLength(1)
    const event = channel.deliveries.at(-1)?.event as DiscordEvent
    expect(channel.adapter.toIngress(event)).toBeNull()
    expect(channel.adapter.toOverflowTaken(event)).toBeNull()
  })
})

// ADR-0028 moved the remedy for a failed post into `deliver`, because
// re-reading a socket repairs no POST. What that retry inherits here is a
// penalty Chat has no counterpart for: a 429 counts toward an invalid-request
// budget of 10,000 per 10 minutes whose block is on the whole API rather than on
// the channel that earned it, so a loop in one Conversation is an outage of
// every Conversation — the Gateway included.
describe('a call Discord refused', () => {
  it('waits exactly as long as Discord asked before trying again', async () => {
    const channel = await messaged(inDm())
    channel.api.failNext('post', refusal(429, 1_500))

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    // Read off the response, never hard coded: Discord's per-route limits are
    // dynamic and its reference says so in as many words.
    expect(channel.waits).toEqual([1_500])
    expect(channel.api.texts).toEqual(['the answer'])
  })

  // Where Discord named no time at all — a 503, or a socket that never answered
  // — roma backs off on its own clock rather than hammering.
  it('backs off on its own clock where Discord named no time', async () => {
    const channel = await messaged(inDm())
    channel.api.failNext('post', refusal(503))

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(channel.waits).toEqual([RETRY_FLOOR_MS])
  })

  it('gives up rather than trying for ever', async () => {
    const channel = await messaged(inDm())
    channel.api.failEvery('post', refusal(429, 100))

    await expect(
      channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' })),
    ).rejects.toThrow(/429/)
    expect(channel.api.calls.filter((call) => call === 'post')).toHaveLength(ATTEMPTS)
  })

  // A wait this long is a block on the whole API rather than a bucket refilling,
  // and sleeping through one inside `deliver` holds the Task and everything
  // queued behind it for as long as it lasts.
  it('gives up rather than sleeping through a ban', async () => {
    const channel = await messaged(inDm())
    channel.api.failEvery('post', refusal(429, RETRY_CEILING_MS + 1))

    await expect(
      channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' })),
    ).rejects.toThrow(/429/)
    expect(channel.waits).toEqual([])
    expect(channel.api.calls.filter((call) => call === 'post')).toHaveLength(1)
  })

  // Every attempt at something Discord will go on refusing is another entry in
  // the budget whose penalty is the block above. A 403 is a permission roma does
  // not have, and it will not have it a second later either.
  it('does not try again where trying again cannot work', async () => {
    const channel = await messaged(inDm())
    channel.api.failEvery('post', refusal(403))

    await expect(
      channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' })),
    ).rejects.toThrow(/403/)
    expect(channel.waits).toEqual([])
    expect(channel.api.calls.filter((call) => call === 'post')).toHaveLength(1)
  })

  /**
   * **Opening a thread is not idempotent, and forgetting that makes every retry
   * permanent.** *"A message can only have a single thread created from it"* —
   * so a creation that Discord carried out and then failed to report is one
   * roma re-attempts, and the second attempt must be read as the thread it
   * wanted rather than as a refusal. Read as a refusal, the answer goes to the
   * parent channel of a thread roma had already opened.
   *
   * What `HttpDiscordApi` reads out of the 400 to decide that is asserted in
   * `http-discord-api.test.ts`; what is asserted here is that roma asks again
   * and speaks in what it is handed back.
   */
  it('treats a re-attempted thread as the thread it wanted, and posts into it', async () => {
    const channel = await messaged(addressed())
    channel.api.failNext('startThread', refusal(500))

    await channel.adapter.deliver(to(MESSAGE, { kind: 'result', text: 'the answer' }))

    expect(channel.api.threads).toHaveLength(2)
    expect(channel.api.messages[0]?.posted.channel).toBe(MESSAGE)
  })

  // A socket that failed carries no status, so there is nothing to say Discord
  // refused anything — and the request may in fact have arrived. Retried anyway:
  // a Conversation told twice is a great deal better than one told nothing about
  // a Turn that has already been paid for.
  it('tries again after a fault that never reached Discord at all', async () => {
    const channel = await messaged(inDm())
    channel.api.failNext('post', new Error('socket hang up'))

    await channel.adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(channel.api.texts).toEqual(['the answer'])
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
