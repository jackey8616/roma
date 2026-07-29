import { describe, expect, it } from 'vitest'
import type { Delivery, Settle } from '../../transport.js'
import type { ChatEvent } from './chat-events.js'
import { PubSubTransport, type PubSubLogRecord } from './pubsub-transport.js'
import { FakePubSubMessage, FakeSubscription } from '../../../test/support/fake-pubsub.js'

// SEAM 3 — the Transport on its own: bytes off a subscription in, a Delivery
// out. No project, no credential, no queue, and the subscription is a double —
// roma reads one somebody else created, so there is nothing here to provision
// even in a test.

/** A subscriber over a fake subscription, with everything it did recorded. */
function subscribing() {
  const subscription = new FakeSubscription()
  const log: PubSubLogRecord[] = []
  const taken: Delivery<ChatEvent>[] = []
  const transport = new PubSubTransport({ subscription, log: (record) => log.push(record) })

  return {
    subscription,
    log,
    taken,
    transport,
    /** Start receiving, settling every Delivery the given way. */
    receive: (settle: Settle | 'none' = 'ack') =>
      transport.receive(async (delivery) => {
        taken.push(delivery)
        if (settle === 'ack') await delivery.ack()
        if (settle === 'nack') await delivery.nack()
      }),
  }
}

/** A Chat message event, as Chat publishes one. */
const EVENT = {
  type: 'MESSAGE',
  space: { name: 'spaces/AAAA' },
  message: { sender: { name: 'users/17' }, argumentText: ' hello' },
}

describe('taking events off the subscription', () => {
  it('hands the decoded event over, named by the message id', async () => {
    const sub = subscribing()
    await sub.receive()

    sub.subscription.publishJson(EVENT, 'msg-1')

    expect(sub.taken).toHaveLength(1)
    expect(sub.taken[0]).toMatchObject({ id: 'msg-1', event: EVENT })
  })

  // The id is Pub/Sub's own, which is what makes it the same across
  // redeliveries — the property the subscriber's in-flight check depends on.
  // An id minted here would be different every time and would catch nothing.
  it('settles the message the way roma settled the delivery', async () => {
    const acking = subscribing()
    await acking.receive('ack')
    const acked = acking.subscription.publishJson(EVENT, 'msg-1')
    await flushed()

    const nacking = subscribing()
    await nacking.receive('nack')
    const nacked = nacking.subscription.publishJson(EVENT, 'msg-2')
    await flushed()

    expect(acked.settlements).toEqual(['ack'])
    expect(nacked.settlements).toEqual(['nack'])
  })

  it('closes the subscription when roma stops', async () => {
    const sub = subscribing()
    await sub.receive()

    await sub.transport.close()

    expect(sub.subscription.closed).toBe(true)
  })
})

describe('a message roma cannot make an event out of', () => {
  // Acknowledged rather than handed back, and it never reaches the Core. Bytes
  // that are not JSON will not become JSON on the next attempt, so redelivering
  // makes one bad message something the subscriber trips over for as long as the
  // subscription keeps it — which is the whole distance between "rejected" and
  // "stops the subscriber".
  it('acknowledges bytes that are not JSON, and never passes them on', async () => {
    const sub = subscribing()
    await sub.receive()

    const message = new FakePubSubMessage('msg-1', 'not json at all {')
    sub.subscription.publish(message)
    await flushed()

    expect(message.settlements).toEqual(['ack'])
    expect(sub.taken).toEqual([])
    expect(sub.log).toEqual([
      { event: 'pubsub-undecodable', messageId: 'msg-1', reason: expect.any(String) },
    ])
  })

  // Valid JSON that is not an object: a bare string, a list, a null. An Adapter
  // reads fields off an event, and there are no fields on any of these.
  it('acknowledges JSON that is not an event', async () => {
    const sub = subscribing()
    await sub.receive()

    for (const payload of ['hello', 42, null, ['a', 'list']]) {
      const message = sub.subscription.publishJson(payload, 'msg-x')
      await flushed()
      expect(message.settlements).toEqual(['ack'])
    }

    expect(sub.taken).toEqual([])
  })

  it('takes the next message after one it could not decode', async () => {
    const sub = subscribing()
    await sub.receive()

    sub.subscription.publish(new FakePubSubMessage('msg-1', '}{'))
    await flushed()
    sub.subscription.publishJson(EVENT, 'msg-2')
    await flushed()

    expect(sub.taken.map(({ id }) => id)).toEqual(['msg-2'])
  })
})

describe('surviving the things a subscription does', () => {
  // A stream error is Pub/Sub's business to recover from — the client library
  // reconnects — and roma's business only to write down. Thrown from a listener
  // it would be an unhandled error taking the process with it, which is a
  // network blip ending roma.
  it('writes down a subscription error rather than throwing it', async () => {
    const sub = subscribing()
    await sub.receive()

    expect(() => sub.subscription.fail(new Error('stream reset'))).not.toThrow()
    expect(sub.log).toEqual([{ event: 'pubsub-error', reason: 'stream reset' }])
  })

  // The receiver is not supposed to reject — settling is its job, and it has
  // better information than this side does about whether an attempt is worth
  // repeating. If it ever does, the message is handed back rather than left to
  // sit until its lease expires, and the subscriber stays up.
  it('hands the message back if the receiver throws, and keeps going', async () => {
    const subscription = new FakeSubscription()
    const log: PubSubLogRecord[] = []
    const transport = new PubSubTransport({ subscription, log: (record) => log.push(record) })
    await transport.receive(() => Promise.reject(new Error('nothing took it')))

    const message = new FakePubSubMessage('msg-1', JSON.stringify(EVENT))
    subscription.publish(message)
    await flushed()

    expect(message.settlements).toEqual(['nack'])
    expect(log).toEqual([
      { event: 'pubsub-unreceived', messageId: 'msg-1', reason: 'nothing took it' },
    ])
    expect(subscription.listening).toBe(true)
  })
})

/** Let the message handler, which runs detached from `publish`, finish. */
function flushed(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
