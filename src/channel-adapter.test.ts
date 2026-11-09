import { describe, expect, it } from 'vitest'
import type { IngressMessage, PendingEnclosure } from './channel-adapter.js'

describe('what a Channel hands the Core', () => {
  it('cannot leave out a name, what came with it, or what it quotes [fence:adapter-ingress-says-everything]', () => {
    const why =
      'callerName, enclosures, quotation and an Enclosure’s from are required and nullable, ' +
      'never optional (ADR-0009, ADR-0011, ADR-0021): a Channel that had one and forgot to ' +
      'hand it over is indistinguishable from a Channel that had none, and the failure is ' +
      'silent. Optional, these objects compile and the @ts-expect-error lines fail typecheck.'
    const redeem = () => Promise.resolve(new Uint8Array())
    const complete: IngressMessage = {
      conversationKey: 'c',
      caller: 'users/1',
      callerName: null,
      text: 'hi',
      enclosures: [{ name: 'a.png', from: null, redeem }],
      quotation: null,
    }
    // @ts-expect-error -- fence:adapter-ingress-says-everything
    const noName: IngressMessage = {
      conversationKey: 'c',
      caller: 'users/1',
      text: 'hi',
      enclosures: [],
      quotation: null,
    }
    // @ts-expect-error -- fence:adapter-ingress-says-everything
    const noEnclosures: IngressMessage = {
      conversationKey: 'c',
      caller: 'users/1',
      callerName: null,
      text: 'hi',
      quotation: null,
    }
    // @ts-expect-error -- fence:adapter-ingress-says-everything
    const noQuotation: IngressMessage = {
      conversationKey: 'c',
      caller: 'users/1',
      callerName: null,
      text: 'hi',
      enclosures: [],
    }
    // @ts-expect-error -- fence:adapter-ingress-says-everything
    const noFrom: PendingEnclosure = { name: 'a.png', redeem }

    expect(Object.keys(complete), why).toHaveLength(6)
    expect(
      [noName, noEnclosures, noQuotation].map((message) => Object.keys(message).length),
      why,
    ).toEqual([5, 5, 5])
    expect(Object.keys(noFrom), why).toEqual(['name', 'redeem'])
  })
})
