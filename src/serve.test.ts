import { afterEach, describe, expect, it } from 'vitest'
import type { Credential } from './build-env.js'
import type { IngressMessage } from './channel-adapter.js'
import { bind, serve, type IngressLogRecord, type ServeLog, type Serving } from './serve.js'
import { StartupSelfCheckFailed } from './startup-self-check.js'
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

// SEAM 1, at the outermost edge roma has: an event arrives on the Transport and
// what comes out is a Channel that was told something and a Delivery that was
// settled. Claude Code is the recorded fake, the Channel is the recording
// double, and the queue is a Transport a test drives by hand — so what is
// asserted here is roma's own wiring, not anybody's client library.

const OAUTH: Credential = { kind: 'shared-window', oauthToken: 'oauth-token' }
const METERED: Credential = { kind: 'overflow', apiKey: 'metered-key' }
const KEY = 'conversation-one'

/**
 * One ingress message, as the recording Channel's events already are.
 *
 * Annotated rather than inferred, which is not decoration: an unannotated
 * literal here type-checks against nothing, so a field added to
 * `IngressMessage` is missing at runtime in every test in this file and in
 * none of the compiler's output.
 */
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

function boot({ overflow = true, channels = 1 }: { overflow?: boolean; channels?: number } = {}) {
  const fixture = romaFixture('serve')
  fixtures.push(fixture)
  // One Channel and the Transport its events arrive over, per Channel asked for.
  // Two instances of each double is the whole of what a second Channel takes
  // here, which is the point: `FakeTransport` and `RecordingAdapter` were
  // already parameterised, so nothing new had to be built to see two of them.
  const bound = Array.from({ length: channels }, () => ({
    channel: new RecordingAdapter(),
    transport: new FakeTransport(),
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
  // Attached now rather than by whichever test awaits it. Answering the probe
  // takes two exchanges since ADR-0016 — the Turn, then the relayed `/effort
  // current` — so a boot that refuses on the first one rejects while the fixture
  // is still between them.
  serving.catch(() => {})

  const [first] = bound
  return {
    claude: fixture.claude,
    /** The first Channel's, for the tests that are about one Channel. */
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

/**
 * The subscriber's own records, kept, and everything else dropped.
 *
 * The pool's and the Cores' lines are traffic to this file; `IngressLogRecord`
 * is what `serve` itself decided, and two of its five are the only trace their
 * Delivery leaves anywhere.
 */
function ingressOnly(kept: IngressLogRecord[]): ServeLog {
  return (record) => {
    if (record.event.startsWith('ingress-')) kept.push(record as IngressLogRecord)
  }
}

/** Boot, pass the self-check, and be receiving. */
async function booted(options?: { overflow?: boolean; channels?: number }) {
  const roma = boot(options)
  await roma.answerProbe()
  await roma.serving
  return roma
}

/** Which Conversations one Channel was asked to post into, in the order it was asked. */
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
  // The acceptance criterion, and the only form it can take: there is nothing
  // subscribed to the queue until the self-check has passed, so there is no
  // window in which a message could arrive at a roma that has not proved its
  // credential.
  it('receives nothing until the self-check has passed', async () => {
    const roma = boot()

    await flush()
    expect(roma.transport.receiving).toBe(false)
    // One process, and it is the probe.
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

  // The settling is timed, not merely done. A Delivery finished with on arrival
  // is gone the moment roma dies, and whoever sent it waits for an answer
  // nothing is working on any more — so settling waits for the Conversation to
  // have been answered, and a crash before that leaves the message on the queue
  // to be delivered again.
  it('settles a Delivery only once the Conversation has been answered', async () => {
    const roma = await booted()

    const delivered = roma.transport.deliver(said('hello'), 'm-1')
    await flush()

    // Mid-Task: the Conversation has its Acknowledgement, and the Delivery is
    // still unsettled.
    expect(roma.channel.instructions.some(({ kind }) => kind === 'progress')).toBe(true)
    expect(roma.transport.settlements).toEqual([])

    feed(roma.procFor(), OK)
    await delivered

    expect(roma.transport.acked).toEqual(['m-1'])
  })

  // A failed Task is an outcome rather than an error: the Conversation was told
  // what happened, so the work is done and the message is finished with. Handing
  // it back would rerun a Turn that already failed and spent whatever it spent.
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
  // Finished with rather than handed back. It is not a message roma answers and
  // it never will be, so redelivering it makes it something the subscriber
  // trips over on every pass for as long as the subscription keeps it.
  it('finishes with an event that is not one roma answers', async () => {
    const roma = await booted()

    await roma.transport.deliver({ notAMessage: true }, 'm-1')

    expect(roma.transport.acked).toEqual(['m-1'])
    expect(roma.channel.instructions).toEqual([])
  })

  it('finishes with an event the Channel cannot read at all', async () => {
    const roma = await booted()

    await roma.transport.deliver(UNREADABLE, 'm-1')

    expect(roma.transport.acked).toEqual(['m-1'])
    expect(roma.channel.instructions).toEqual([])
  })

  // The half of "rejected without stopping the subscriber" that is worth
  // asserting: rejecting one event is only useful if the next one still works.
  it('keeps serving after one it could not read', async () => {
    const roma = await booted()

    await roma.transport.deliver(UNREADABLE, 'm-1')
    await roma.transport.deliver({ notAMessage: true }, 'm-2')
    const delivered = roma.transport.deliver(said('hello'), 'm-3')
    await flush()
    feed(roma.procFor(), OK)
    await delivered

    expect(roma.channel.instructions.at(-1)).toMatchObject({ kind: 'result', text: 'ok' })
    expect(roma.transport.acked).toEqual(['m-1', 'm-2', 'm-3'])
  })

  // The one failure that is worth another attempt, and the only one the Core
  // reports by rejecting: the Conversation was never told anything. Handed back,
  // it is delivered again once the Channel is reachable; finished with, it is a
  // Task that ran, spent quota, and told nobody.
  it('hands back a Delivery the Channel could not be told about', async () => {
    const roma = await booted()
    roma.channel.refuse('result', new Error('Chat is unreachable'))

    const delivered = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    feed(roma.procFor(), OK)
    await delivered

    expect(roma.transport.nacked).toEqual(['m-1'])
  })
})

describe('serving more than one Channel from one process', () => {
  // The whole of what a second Channel is: a second Core over the same
  // everything, each with exactly one place to reply to. A Core that answered
  // into the other Channel would be a message posted where nobody sent it, and
  // no Adapter could tell — neither of them ever learns the other exists.
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

  // The cap is three across the whole of roma rather than three per Channel, and
  // that is what one process buys: the queue is built once and handed to every
  // Core. Two processes with a Channel each would run six Tasks against one
  // Shared Window with no configuration looking wrong (ADR-0028).
  it('runs three Tasks at once across both Channels, not three each', async () => {
    const roma = await booted({ channels: 2 })
    const [first, second] = roma.channels
    // Counted rather than assumed zero: the Startup Self-Check has spawned its
    // own probe by now, and what this is about is the three after it.
    const started = roma.claude.processes.length

    // Two Conversations on each, so nothing here waits by sharing a Session:
    // what holds the fourth back is the cap, and only the cap.
    const delivered = [
      first!.transport.deliver(said('hello', 'one'), 'm-1'),
      first!.transport.deliver(said('hello', 'two'), 'm-2'),
      second!.transport.deliver(said('hello', 'three'), 'm-3'),
      second!.transport.deliver(said('hello', 'four'), 'm-4'),
    ]
    await flush()

    expect(roma.claude.processes).toHaveLength(started + 3)
    // Told so rather than merely held: the fourth is the second Channel's, and
    // it is waiting behind Tasks it can neither see nor be told about.
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
  // ADR-0028: what `nack` buys is the Transport's, and a socket roma holds open
  // has nothing to give the event back to — `FakeTransport`'s `nack` is exactly
  // that, a settlement that hands nothing anywhere. What has to survive it is
  // `take`: the failure is written down, the Delivery is settled all the same,
  // and the subscriber is still running afterwards. Nothing here branches on
  // which kind of Transport it is, which is the decision rather than an omission.
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

describe('the same message delivered twice', () => {
  // At-least-once is what a queue promises, and roma holds a delivery for as
  // long as the Task takes — minutes, sometimes. A redelivery arriving in that
  // window is the same work, and running it twice would spend the Turn twice and
  // post two answers into one Conversation.
  it('drops a redelivery of work it is still doing', async () => {
    const roma = await booted()

    const first = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    const second = roma.transport.deliver(said('hello'), 'm-1')
    await second

    // The redelivery settled nothing: the Delivery it duplicates is still
    // outstanding, and the attempt that is doing the work is the one that owns
    // the settling.
    expect(roma.transport.settlements).toEqual([])

    feed(roma.procFor(), OK)
    await first

    expect(roma.transport.acked).toEqual(['m-1'])
    // Two results, and only one of them is an answer: the Session's Opening goes
    // out ahead of the work, and the redelivery produced neither.
    const results = roma.channel.instructions.filter((instruction) => instruction.kind === 'result')
    expect(results).toHaveLength(2)
    expect(results.filter((instruction) => instruction.text === 'ok')).toHaveLength(1)
  })

  // Only while it is in flight. Once a Task is answered the id is forgotten, so
  // this is a guard against doing one piece of work twice at once rather than a
  // record of everything roma has ever seen — which it could not keep anyway,
  // since roma has no database and a restart would empty it.
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

    expect(roma.transport.acked).toEqual(['m-1', 'm-1'])
  })
})

describe('an event that answers an offer rather than asking for work', () => {
  // The other thing a Channel can deliver, and the reason the subscriber asks
  // two questions of every event. A button press is not an ingress message: it
  // names a Task roma is already holding, so it drives no Turn of its own and
  // starts no second Task.
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

    // The same Task, rerun on the metered environment map.
    expect(roma.claude.lastSpawn.env).toMatchObject({ ANTHROPIC_API_KEY: 'metered-key' })
    expect(roma.channel.instructions.at(-1)).toMatchObject({ kind: 'result', text: 'ok' })
    // The press is its own Delivery and is finished with immediately; the Task's
    // own Delivery is settled when the Task ends.
    expect(roma.transport.acked).toEqual(['m-2', 'm-1'])
  })

  // Nothing happened, and nothing is owed. An offer that has since been taken,
  // withdrawn or never made is not an error and not work — saying so is the
  // Adapter's business, and the delivery is finished with either way.
  it('finishes with a press against an offer that is no longer open', async () => {
    const roma = await booted()

    await roma.transport.deliver({ takeOverflow: 'a-task-that-is-over' }, 'm-1')

    expect(roma.transport.acked).toEqual(['m-1'])
  })
})

describe('shutting down', () => {
  // Both halves, in this order. Stopping the subscriber first is what keeps roma
  // from taking on work it is about to kill; ending the processes is what keeps
  // a restart from leaving `claude` processes behind with nothing to talk to.
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

  // The Task is killed with the process, so the Conversation is told it failed
  // — and the Delivery is handed back rather than finished with, so the work
  // comes round again on whatever starts next. Finished with instead, it would
  // be a message somebody sent, was told had failed, and has to send again,
  // which is precisely the losing that holding the Delivery exists to prevent.
  it('hands back a Delivery it was still working on', async () => {
    const roma = await booted()

    const delivered = roma.transport.deliver(said('hello'), 'm-1')
    await flush()
    // Mid-Task, with nothing settled yet.
    expect(roma.transport.settlements).toEqual([])

    const stopped = (await roma.serving).shutdown()
    await delivered
    await stopped

    expect(roma.transport.nacked).toEqual(['m-1'])
    expect(roma.transport.acked).toEqual([])
  })

  // Every Transport, and the pool once. Once is the half worth asserting: the
  // pool, the queue and the Audit Log are roma's rather than a Channel's, so a
  // shutdown that ended them per Channel would end them again under whatever the
  // first one left running.
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

  // The one failure that must not stop the rest of shutting down. A `close` that
  // rejected and took the pool with it would leave `claude` processes running
  // with nothing to talk to — which is the whole of what this is for.
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
