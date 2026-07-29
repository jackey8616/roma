import { describe, expect, it } from 'vitest'
import { ROMA_NAMESPACE, sessionIdFor, uuidv5 } from './session-id.js'

/** RFC 9562's own namespaces, here only to check the algorithm against its vectors. */
const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'

const V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('a Session id derived from a Conversation Key', () => {
  // The whole reason roma needs no database: the mapping is computed, so nothing
  // has to remember it. Two runs of roma, two machines, and a restart in between
  // all reach the same Session for the same Conversation.
  it('is the same every time for the same Conversation Key', () => {
    expect(sessionIdFor('conversation-one')).toBe(sessionIdFor('conversation-one'))
  })

  it('is a different Session for a different Conversation', () => {
    expect(sessionIdFor('conversation-one')).not.toBe(sessionIdFor('conversation-two'))
  })

  // Pinned as literals rather than compared to a recomputation, because the thing
  // that can break here is the namespace changing. Recomputing agrees with itself
  // however the namespace moves; these values do not. A change to them orphans
  // every transcript on disk and every live Conversation at once.
  it('is these ids, for as long as roma keeps the Sessions it already has', () => {
    expect(sessionIdFor('conversation-one')).toBe('4a03e16d-42d9-58c9-9eae-8468b8b6efae')
    expect(sessionIdFor('conversation-two')).toBe('9cec7e33-0a30-556c-bbf4-39cd9a77bc92')
  })

  it('is a uuid, which is the only kind of id Claude Code accepts', () => {
    expect(sessionIdFor('conversation-one')).toMatch(V5)
  })

  // An Adapter with a bug that produces an empty key would otherwise collapse
  // every Conversation on that Channel into one shared Session — everybody's
  // context in everybody else's replies, and no error anywhere saying so.
  it('refuses an empty Conversation Key rather than sharing one Session out', () => {
    expect(() => sessionIdFor('')).toThrow(/conversation key/i)
    expect(() => sessionIdFor('   ')).toThrow(/conversation key/i)
  })
})

describe('a Session generation', () => {
  // What `/new` moves. The Conversation Key cannot change — it is the Channel's,
  // and the same DM keeps it forever — so a fresh Session has to come from
  // somewhere else, and this is the only thing in the derivation roma owns.
  it('is a different Session for the same Conversation', () => {
    expect(sessionIdFor('conversation-one', 1)).not.toBe(sessionIdFor('conversation-one'))
    expect(sessionIdFor('conversation-one', 2)).not.toBe(sessionIdFor('conversation-one', 1))
  })

  it('is still derived, so the same generation always reaches the same Session', () => {
    expect(sessionIdFor('conversation-one', 3)).toBe(sessionIdFor('conversation-one', 3))
  })

  it('is still a uuid, whichever generation it is', () => {
    expect(sessionIdFor('conversation-one', 7)).toMatch(V5)
  })

  // The generation is not part of the Conversation Key, so no key an Adapter
  // could mint names another Conversation's later generation. A key and a
  // generation joined with a printable separator would have let one do exactly
  // that.
  it('cannot be spelled out in a Conversation Key', () => {
    expect(sessionIdFor('conversation-one#1')).not.toBe(sessionIdFor('conversation-one', 1))
    expect(sessionIdFor('conversation-one 1')).not.toBe(sessionIdFor('conversation-one', 1))
  })

  // Generation zero is where every Conversation starts and where all of them are
  // today, so its ids are the ones already on disk. Rotating a Session must not
  // rename the Sessions that never rotated.
  it('leaves the first generation at the id it already had', () => {
    expect(sessionIdFor('conversation-one', 0)).toBe('4a03e16d-42d9-58c9-9eae-8468b8b6efae')
  })

  it('refuses a generation that is not a whole count', () => {
    expect(() => sessionIdFor('conversation-one', -1)).toThrow(/generation/i)
    expect(() => sessionIdFor('conversation-one', 1.5)).toThrow(/generation/i)
  })
})

describe('uuidv5', () => {
  // The published vectors. This is the test that says the implementation is
  // uuidv5 rather than something that merely looks like it.
  it('agrees with RFC 9562', () => {
    expect(uuidv5('www.example.com', DNS_NAMESPACE)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
    expect(uuidv5('www.example.com', URL_NAMESPACE)).toBe('b63cdfa4-3df9-568e-97ae-006c5b8fd652')
  })

  it('hashes the namespace as well as the name', () => {
    expect(uuidv5('www.example.com', DNS_NAMESPACE)).not.toBe(
      uuidv5('www.example.com', URL_NAMESPACE),
    )
  })

  it('reads the namespace as bytes, not as the text it is written in', () => {
    expect(uuidv5('x', DNS_NAMESPACE.toUpperCase())).toBe(uuidv5('x', DNS_NAMESPACE))
  })

  it('rejects a namespace that is not a uuid', () => {
    expect(() => uuidv5('x', 'not-a-uuid')).toThrow(/namespace/i)
  })

  it("is what derives a Session id, under roma's own namespace", () => {
    expect(sessionIdFor('conversation-one')).toBe(uuidv5('conversation-one', ROMA_NAMESPACE))
  })
})
