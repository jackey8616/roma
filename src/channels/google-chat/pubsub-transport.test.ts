import { describe, expect, it } from 'vitest'
import type { Delivery, Settle } from '../../transport.js'
import type { ChatEvent } from './chat-events.js'
import { PubSubTransport, type PubSubLogRecord } from './pubsub-transport.js'
import { FakePubSubMessage, FakeSubscription } from '../../../test/support/fake-pubsub.js'

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
    receive: (settle: Settle | 'none' = 'ack') =>
      transport.receive(async (delivery) => {
        taken.push(delivery)
        if (settle === 'ack') await delivery.ack()
        if (settle === 'nack') await delivery.nack()
      }),
  }
}

const EVENT = {
  type: 'MESSAGE',
  space: { name: 'spaces/AAAA' },
  message: { sender: { name: 'users/17' }, argumentText: ' hello' },
}

describe('taking events off the subscription', () => {
  it('hands the decoded event over, named by the message id [fence:gchat-delivery-is-named-by-pubsub]', async () => {
    const why =
      "A Delivery's id is Pub/Sub's own message id, the same on every redelivery (ADR-0003: " +
      'ingress is a queue that redelivers, and the in-flight check keys on this id). An id minted on ' +
      'arrival differs every time, the check catches nothing, and a redelivered event runs ' +
      'twice (#31).'
    const sub = subscribing()
    await sub.receive()

    sub.subscription.publishJson(EVENT, 'msg-1')

    expect(sub.taken).toHaveLength(1)
    expect(sub.taken[0], why).toMatchObject({ id: 'msg-1', event: EVENT })
  })

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
  it('writes down a subscription error rather than throwing it [fence:gchat-subscription-error-is-written-down]', async () => {
    const why =
      'A subscription error is written to the Operator Log and never thrown (ADR-0005). The ' +
      'client library is already reconnecting; a listener that throws is an unhandled error ' +
      'taking the process down over a network blip (#31).'
    const sub = subscribing()
    await sub.receive()

    expect(() => sub.subscription.fail(new Error('stream reset')), why).not.toThrow()
    expect(sub.log, why).toEqual([{ event: 'pubsub-error', reason: 'stream reset' }])
  })

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

function flushed(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
