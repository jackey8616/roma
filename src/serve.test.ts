import { afterEach, describe, expect, it } from 'vitest'
import type { Credential } from './build-env.js'
import type { IngressMessage } from './channel-adapter.js'
import { bind, serve, type IngressLogRecord, type ServeLog, type Serving } from './serve.js'
import { StartupSelfCheckFailed } from './startup-self-check.js'
import type { Receiver } from './transport.js'
import { flush } from '../test/support/fake-claude.js'
import { fakeReaches, fakeShims } from '../test/support/fake-minter.js'
import { FakeTransport } from '../test/support/fake-transport.js'
import { RecordingAdapter, UNREADABLE } from '../test/support/recording-adapter.js'
import { romaFixture, teardownRoma, type RomaFixture } from '../test/support/roma-fixture.js'
import {
  BLOCKED_WITH_OVERAGE,
  FAILED_OUTRIGHT,
  feed,
  OK,
  STRAY_KEY,
  THREE_TURNS,
} from '../test/support/recorded-stream.js'

const OAUTH: Credential = { kind: 'shared-window', oauthToken: 'oauth-token' }
const METERED: Credential = { kind: 'overflow', apiKey: 'metered-key' }
const KEY = 'conversation-one'

function said(text: string, conversationKey = KEY): IngressMessage {
  return {
    conversationKey,
    caller: 'ada',
    callerName: 'Ada',
    text,
    enclosures: [],
    quotation: null,
  }
}

let running: Serving[] = []
let fixtures: RomaFixture[] = []

class RefusingTransport extends FakeTransport {
  refuseNextAck = false

  override receive(receiver: Receiver): Promise<void> {
    return super.receive((delivery) =>
      receiver({
        ...delivery,
        ack: () => {
          if (!this.refuseNextAck) return delivery.ack()
          this.refuseNextAck = false
          throw new Error('the lease on that message has expired')
        },
      }),
    )
  }
}

interface BootOptions {
  overflow?: boolean
  channels?: number
}

function boot({ overflow = true, channels = 1 }: BootOptions = {}) {
  const fixture = romaFixture('serve')
  fixtures.push(fixture)
  const bound = Array.from({ length: channels }, () => ({
    channel: new RecordingAdapter(),
    transport: new RefusingTransport(),
  }))
  const log: IngressLogRecord[] = []

  let resolved = false
  const shims = fakeShims()
  fixture.alsoRemove(shims.dir)
  const serving = serve({
    credential: OAUTH,
    reaches: fakeReaches(),
    shims,
    ...(overflow ? { overflow: { credential: METERED, monthlyCapUsd: 100 } } : {}),
    channels: bound.map(({ channel, transport }) => bind(channel, transport)),
    ...fixture.dirs,
    spawn: fixture.claude.spawn,
    log: ingressOnly(log),
    selfCheckTimeoutMs: 1_000,
  }).then((roma) => {
    resolved = true
    running.push(roma)
    return roma
  })
  serving.catch(() => {})

  const [first] = bound
  return {
    claude: fixture.claude,
    channel: first!.channel,
    transport: first!.transport,
    channels: bound,
    log,
    serving,
    hasStarted: () => resolved,
    answerProbe: fixture.answerProbe,
    procFor: (conversationKey = KEY) => fixture.procFor(conversationKey),
  }
}

function ingressOnly(kept: IngressLogRecord[]): ServeLog {
  return (record) => {
    if (record.event.startsWith('ingress-')) kept.push(record as IngressLogRecord)
  }
}

async function booted(options?: BootOptions) {
  const roma = boot(options)
  await roma.answerProbe()
  await roma.serving
  return roma
}

function conversationsOf(channel: RecordingAdapter): string[] {
  return [...new Set(channel.instructions.map(({ conversationKey }) => conversationKey))]
}

afterEach(async () => {
  await teardownRoma(
    running,
    fixtures.flatMap(({ roots }) => roots),
  )
  running = []
  fixtures = []
})

describe('accepting messages only once roma is fit to serve them', () => {
  it('receives nothing until the self-check has passed', async () => {
    const roma = boot()

    await flush()
    expect(roma.transport.receiving).toBe(false)
    expect(roma.claude.spawns).toHaveLength(1)

    await roma.answerProbe()
    await roma.serving

    expect(roma.transport.receiving).toBe(true)
  })

  it('never subscribes at all when the self-check fails', async () => {
    const roma = boot()

    await roma.answerProbe(STRAY_KEY)

    await expect(roma.serving).rejects.toThrow(StartupSelfCheckFailed)
    expect(roma.transport.receiving).toBe(false)
  })
})

describe('carrying one message from the queue to the Channel and back', () => {
  it('hands an event to the Core and answers it on the Channel', async () => {
    const roma = await booted()

    const delivered = roma.transport.deliver(said('hello'))
    await flush()
    feed(roma.procFor(), OK)
    await delivered

    expect(roma.channel.instructions.at(-1)).toMatchObject({ kind: 'result', text: 'ok' })
  })

  it('settles a Delivery only once the Conversation has been answered', async () => {
    const roma = await booted()

    const delivered = roma.transport.deliver(said('hello'), 'm-1')
    await flush()

    expect(roma.channel.instructions.some(({ kind }) => kind === 'progress')).toBe(true)
    expect(roma.transport.settlements).toEqual([])

    feed(roma.procFor(), OK)
    await delivered

    expect(roma.transport.acked).toEqual(['m-1'])
  })

  it('finishes with a Task that failed, because the Conversation was told', async () => {
    const roma = await booted()

    const delivered = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    feed(roma.procFor(), FAILED_OUTRIGHT)
    await delivered

    expect(roma.channel.instructions.at(-1)).toMatchObject({ kind: 'failure' })
    expect(roma.transport.acked).toEqual(['m-1'])
  })
})

describe('an event roma cannot or should not answer', () => {
  const UNREADABLE_WHY =
    'An event the Channel cannot read must be finished with (acked) and logged as ' +
    '`ingress-unreadable` (ADR-0028). Handed back, it fails identically for ever and the ' +
    'subscriber trips over it on every pass; unlogged, roma drops it with no trace, since ' +
    'working out which Conversation to tell is the very thing that failed (#31).'
  const NEVER_REJECTS =
    '`take` must never reject, on any path (ADR-0028: a Transport may treat a rejection as a ' +
    'bug). A subscriber that falls over on one bad event, or on a settlement the queue ' +
    'refused, makes one malformed message the end of roma answering anybody (#31).'

  it('finishes with an event that is not one roma answers', async () => {
    const roma = await booted()

    await roma.transport.deliver({ notAMessage: true }, 'm-1')

    expect(roma.transport.acked).toEqual(['m-1'])
    expect(roma.channel.instructions).toEqual([])
  })

  it('finishes with an event the Channel cannot read at all [fence:serve-unreadable-is-finished-and-logged]', async () => {
    const roma = await booted()

    await roma.transport.deliver(UNREADABLE, 'm-1')

    expect(roma.transport.acked, UNREADABLE_WHY).toEqual(['m-1'])
    expect(roma.log, UNREADABLE_WHY).toContainEqual({
      event: 'ingress-unreadable',
      deliveryId: 'm-1',
      reason: expect.any(String),
    })
    expect(roma.channel.instructions).toEqual([])
  })

  it('keeps serving after one it could not read [fence:serve-take-never-rejects]', async () => {
    const roma = await booted()

    await expect(roma.transport.deliver(UNREADABLE, 'm-1'), NEVER_REJECTS).resolves.toBeUndefined()
    await roma.transport.deliver({ notAMessage: true }, 'm-2')
    const delivered = roma.transport.deliver(said('hello'), 'm-3')
    await flush()
    feed(roma.procFor(), OK)
    await delivered

    expect(roma.channel.instructions.at(-1), NEVER_REJECTS).toMatchObject({
      kind: 'result',
      text: 'ok',
    })
    expect(roma.transport.acked, NEVER_REJECTS).toEqual(['m-1', 'm-2', 'm-3'])
  })

  it('survives the queue refusing to hear a settlement [fence:serve-take-never-rejects]', async () => {
    const roma = await booted()
    const transport = roma.transport as RefusingTransport
    transport.refuseNextAck = true

    const refused = transport.deliver(said('hello'), 'm-1')
    await flush()
    feed(roma.procFor(), OK)
    await expect(refused, NEVER_REJECTS).resolves.toBeUndefined()

    expect(roma.log, NEVER_REJECTS).toContainEqual({
      event: 'ingress-unsettled',
      deliveryId: 'm-1',
      settle: 'ack',
      reason: expect.stringContaining('lease'),
    })

    const next = transport.deliver(said('and again'), 'm-2')
    await flush()
    feed(roma.procFor(), THREE_TURNS.turn(2))
    await next

    expect(transport.acked, NEVER_REJECTS).toEqual(['m-2'])
  })

  it('hands back a Delivery the Channel could not be told about [fence:serve-take-never-rejects]', async () => {
    const roma = await booted()
    roma.channel.refuse('result', new Error('Chat is unreachable'))

    const delivered = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    feed(roma.procFor(), OK)
    await expect(delivered, NEVER_REJECTS).resolves.toBeUndefined()

    expect(roma.transport.nacked).toEqual(['m-1'])
  })
})

describe('serving more than one Channel from one process', () => {
  it('answers each Channel on itself, and neither on the other', async () => {
    const roma = await booted({ channels: 2 })
    const [first, second] = roma.channels

    const one = first!.transport.deliver(said('hello', 'on-the-first'), 'm-1')
    const two = second!.transport.deliver(said('hello', 'on-the-second'), 'm-2')
    await flush()
    feed(roma.procFor('on-the-first'), OK)
    feed(roma.procFor('on-the-second'), OK)
    await Promise.all([one, two])

    expect(conversationsOf(first!.channel)).toEqual(['on-the-first'])
    expect(conversationsOf(second!.channel)).toEqual(['on-the-second'])
    expect(first!.transport.acked).toEqual(['m-1'])
    expect(second!.transport.acked).toEqual(['m-2'])
  })

  it('runs three Tasks at once across both Channels, not three each [fence:queue-one-for-all-channels]', async () => {
    const why =
      'Every Core must share the one TaskQueue (ADR-0028; the cap is ADR-0003’s). A queue ' +
      'held per Core or per Channel quietly makes the cap of three into three per Channel: ' +
      'six Tasks against one Shared Window, with no configuration looking wrong (#23).'
    const roma = await booted({ channels: 2 })
    const [first, second] = roma.channels
    const started = roma.claude.processes.length

    const delivered = [
      first!.transport.deliver(said('hello', 'one'), 'm-1'),
      first!.transport.deliver(said('hello', 'two'), 'm-2'),
      second!.transport.deliver(said('hello', 'three'), 'm-3'),
      second!.transport.deliver(said('hello', 'four'), 'm-4'),
    ]
    await flush()

    expect(roma.claude.processes, why).toHaveLength(started + 3)
    expect(second!.channel.instructions.at(-1)).toMatchObject({
      kind: 'progress',
      conversationKey: 'four',
      progress: { phase: 'queued', position: 1 },
    })

    for (const key of ['one', 'two', 'three']) feed(roma.procFor(key), OK)
    await Promise.all(delivered.slice(0, 3))
    await flush()
    feed(roma.procFor('four'), OK)
    await delivered[3]
  })
})

describe('a Transport with nowhere to hand a Delivery back to', () => {
  it('logs the failure, settles anyway, and keeps serving', async () => {
    const roma = await booted()
    roma.channel.refuse('result', new Error('Chat is unreachable'))

    const lost = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    feed(roma.procFor(), OK)
    await lost

    expect(roma.log).toContainEqual({
      event: 'ingress-failed',
      deliveryId: 'm-1',
      reason: expect.stringContaining('Chat is unreachable'),
    })
    expect(roma.transport.nacked).toEqual(['m-1'])

    roma.channel.stopRefusing('result')
    const next = roma.transport.deliver(said('and again'), 'm-2')
    await flush()
    feed(roma.procFor(), THREE_TURNS.turn(2))
    await next

    expect(roma.transport.acked).toEqual(['m-2'])
  })
})

describe('the same message delivered twice [fence:serve-redelivery-dropped-while-in-flight]', () => {
  const WHY =
    'A redelivery of a Delivery roma is still working on must be dropped, and the id forgotten ' +
    'once it is settled (ADR-0028). Run twice at once, it spends the Turn twice and posts two ' +
    'answers into one Conversation; kept for ever, it is a database roma does not have, and a ' +
    'genuine redelivery after the answer is never run (#31).'

  it('drops a redelivery of work it is still doing', async () => {
    const roma = await booted()

    const first = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    const second = roma.transport.deliver(said('hello'), 'm-1')
    await second

    expect(roma.transport.settlements, WHY).toEqual([])

    feed(roma.procFor(), OK)
    await first

    expect(roma.transport.acked, WHY).toEqual(['m-1'])
    const results = roma.channel.instructions.filter((instruction) => instruction.kind === 'result')
    expect(results, WHY).toHaveLength(2)
    expect(
      results.filter((instruction) => instruction.text === 'ok'),
      WHY,
    ).toHaveLength(1)
  })

  it('runs a redelivery that arrives after the first one finished', async () => {
    const roma = await booted()

    const first = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    feed(roma.procFor(), OK)
    await first

    const again = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    feed(roma.procFor(), THREE_TURNS.turn(2))
    await again

    expect(roma.transport.acked, WHY).toEqual(['m-1', 'm-1'])
  })
})

describe('an event that answers an offer rather than asking for work', () => {
  it('takes Overflow on the Task the press names', async () => {
    const roma = await booted()

    const delivered = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    feed(roma.procFor(), BLOCKED_WITH_OVERAGE)
    await flush()

    const blocked = roma.channel.instructions.at(-1)
    expect(blocked).toMatchObject({ kind: 'blocked', overflowOffered: true })

    await roma.transport.deliver({ takeOverflow: blocked?.taskId }, 'm-2')
    await flush()
    feed(roma.procFor(), OK)
    await delivered

    expect(roma.claude.lastSpawn.env).toMatchObject({ ANTHROPIC_API_KEY: 'metered-key' })
    expect(roma.channel.instructions.at(-1)).toMatchObject({ kind: 'result', text: 'ok' })
    expect(roma.transport.acked).toEqual(['m-2', 'm-1'])
  })

  it('finishes with a press against an offer that is no longer open', async () => {
    const roma = await booted()

    await roma.transport.deliver({ takeOverflow: 'a-task-that-is-over' }, 'm-1')

    expect(roma.transport.acked).toEqual(['m-1'])
  })
})

describe('shutting down', () => {
  it('stops receiving before it ends the Resident Sessions', async () => {
    const roma = await booted()
    const order: string[] = []

    const delivered = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    const proc = roma.procFor()
    proc.onExit(() => order.push('session ended'))
    feed(proc, OK)
    await delivered

    const closing = roma.transport.close.bind(roma.transport)
    roma.transport.close = () => {
      order.push('stopped receiving')
      return closing()
    }

    await (await roma.serving).shutdown()

    expect(order).toEqual(['stopped receiving', 'session ended'])
    expect(roma.transport.closed).toBe(true)
    expect(proc.signals).toContain('SIGTERM')
  })

  it('hands back a Delivery it was still working on [fence:serve-shutdown-hands-back]', async () => {
    const why =
      'Once roma is stopping, every settlement must be a hand-back (nack), whatever the work ' +
      'did (ADR-0028). What ended those Tasks was roma being killed, not anything about them; ' +
      'finished with, the Delivery is a message somebody sent, was told had failed, and has ' +
      'to send again (#31).'
    const roma = await booted()

    const delivered = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    expect(roma.transport.settlements).toEqual([])

    const stopped = (await roma.serving).shutdown()
    await delivered
    await stopped

    expect(roma.transport.nacked, why).toEqual(['m-1'])
    expect(roma.transport.acked, why).toEqual([])
  })

  it('stops every Channel before it closes any of them [fence:serve-every-channel-stopped-first]', async () => {
    const why =
      'Shutdown must stop every Channel before it closes any Transport (ADR-0028). Closing ' +
      'takes as long as it takes, and a Task that finishes meanwhile on a Channel not yet ' +
      'stopped is settled as done just before roma kills the work it belonged to (82d6ab6).'
    const roma = await booted({ channels: 2 })
    const [first, second] = roma.channels
    let release = (): void => {}
    const closing = first!.transport.close.bind(first!.transport)
    first!.transport.close = () => {
      first!.transport.close = closing
      return new Promise<void>((resolve) => {
        release = () => void closing().then(resolve)
      })
    }

    const one = first!.transport.deliver(said('hello', 'on-the-first'), 'm-1')
    const two = second!.transport.deliver(said('hello', 'on-the-second'), 'm-2')
    await flush()
    const stopped = (await roma.serving).shutdown()
    await flush()
    feed(roma.procFor('on-the-first'), OK)
    feed(roma.procFor('on-the-second'), OK)
    await Promise.all([one, two])
    release()
    await stopped

    expect(first!.transport.acked, why).toEqual([])
    expect(second!.transport.acked, why).toEqual([])
  })

  it('closes every Channel’s Transport, and ends the pool once', async () => {
    const roma = await booted({ channels: 2 })
    const serving = await roma.serving
    let ended = 0
    const ending = serving.pool.shutdown.bind(serving.pool)
    serving.pool.shutdown = async () => {
      ended += 1
      await ending()
    }

    await serving.shutdown()

    expect(roma.channels.map(({ transport }) => transport.closed)).toEqual([true, true])
    expect(ended).toBe(1)
  })

  it('ends the Resident Sessions even when closing the queue fails', async () => {
    const roma = await booted()

    const delivered = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    const proc = roma.procFor()
    feed(proc, OK)
    await delivered

    roma.transport.close = () => Promise.reject(new Error('the queue is unreachable'))

    await expect((await roma.serving).shutdown()).rejects.toThrow('the queue is unreachable')
    expect(proc.signals).toContain('SIGTERM')
  })
})
