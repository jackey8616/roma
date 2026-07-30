import { afterEach, describe, expect, it } from 'vitest'
import type { Credential } from './build-env.js'
import { serve, type Serving } from './serve.js'
import { StartupSelfCheckFailed } from './startup-self-check.js'
import { flush } from '../test/support/fake-claude.js'
import { fakeMinting } from '../test/support/fake-minter.js'
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

/** One ingress message, as the recording Channel's events already are. */
function said(text: string, conversationKey = KEY) {
  return { conversationKey, caller: 'ada', text }
}

let running: Serving[] = []
let fixtures: RomaFixture[] = []

function boot({ overflow = true }: { overflow?: boolean } = {}) {
  const fixture = romaFixture('serve')
  fixtures.push(fixture)
  const channel = new RecordingAdapter()
  const transport = new FakeTransport()

  let resolved = false
  const minting = fakeMinting()
  fixture.alsoRemove(minting.shimDir)
  const serving = serve({
    credential: OAUTH,
    minting,
    ...(overflow ? { overflow: { credential: METERED, monthlyCapUsd: 100 } } : {}),
    channel,
    transport,
    ...fixture.dirs,
    spawn: fixture.claude.spawn,
    log: () => {},
    selfCheckTimeoutMs: 1_000,
  }).then((roma) => {
    resolved = true
    running.push(roma)
    return roma
  })

  return {
    claude: fixture.claude,
    channel,
    transport,
    serving,
    hasStarted: () => resolved,
    answerProbe: fixture.answerProbe,
    procFor: (conversationKey = KEY) => fixture.procFor(conversationKey),
  }
}

/** Boot, pass the self-check, and be receiving. */
async function booted(options?: { overflow?: boolean }) {
  const roma = boot(options)
  await roma.answerProbe()
  await roma.serving
  return roma
}

afterEach(async () => {
  await teardownRoma(running, fixtures.flatMap(({ roots }) => roots))
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
    expect(roma.channel.instructions.filter(({ kind }) => kind === 'result')).toHaveLength(1)
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
