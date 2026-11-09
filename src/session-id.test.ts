import { describe, expect, it } from 'vitest'
import { ROMA_NAMESPACE, sessionIdFor, uuidv5 } from './session-id.js'

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'

const V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('a Session id derived from a Conversation Key', () => {
  it('is the same every time for the same Conversation Key', () => {
    expect(sessionIdFor('conversation-one')).toBe(sessionIdFor('conversation-one'))
  })

  it('is a different Session for a different Conversation', () => {
    expect(sessionIdFor('conversation-one')).not.toBe(sessionIdFor('conversation-two'))
  })

  it('is these ids, for as long as roma keeps the Sessions it already has [fence:session-id-namespace-is-frozen]', () => {
    const why =
      "roma's uuidv5 namespace, and the derivation under it, must never change (ADR-0003, " +
      'Session identity). Every Session id is derived rather than stored, so a new namespace ' +
      'renames every Session at once: every Transcript Claude Code holds is orphaned and every ' +
      'live Conversation loses its context, with no record to migrate from.'
    expect(sessionIdFor('conversation-one'), why).toBe('4a03e16d-42d9-58c9-9eae-8468b8b6efae')
    expect(sessionIdFor('conversation-two'), why).toBe('9cec7e33-0a30-556c-bbf4-39cd9a77bc92')
  })

  it('is a uuid, which is the only kind of id Claude Code accepts', () => {
    expect(sessionIdFor('conversation-one')).toMatch(V5)
  })

  it('refuses an empty Conversation Key rather than sharing one Session out', () => {
    expect(() => sessionIdFor('')).toThrow(/conversation key/i)
    expect(() => sessionIdFor('   ')).toThrow(/conversation key/i)
  })
})

describe('a Session generation', () => {
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

  it('cannot be spelled out in a Conversation Key [fence:session-id-separator-is-unspellable]', () => {
    const why =
      'A Conversation Key and a generation must be joined by a byte no Channel identifier can ' +
      'carry, never a printable separator (ADR-0003, Where a fresh session comes from). With `#`, a Channel that minted the key ' +
      '`a#1` derives the same id as generation 1 of `a`: one Conversation reading and writing ' +
      "another's Session, with nothing saying so."
    for (let code = 0x20; code < 0x7f; code++) {
      const spelled = `conversation-one${String.fromCharCode(code)}1`
      expect(sessionIdFor(spelled), `${why} (${JSON.stringify(spelled)})`).not.toBe(
        sessionIdFor('conversation-one', 1),
      )
    }
  })

  it('leaves the first generation at the id it already had [fence:session-id-namespace-is-frozen]', () => {
    expect(sessionIdFor('conversation-one', 0)).toBe('4a03e16d-42d9-58c9-9eae-8468b8b6efae')
  })

  it('refuses a generation that is not a whole count', () => {
    expect(() => sessionIdFor('conversation-one', -1)).toThrow(/generation/i)
    expect(() => sessionIdFor('conversation-one', 1.5)).toThrow(/generation/i)
  })
})

describe('uuidv5', () => {
  it('agrees with RFC 9562', () => {
    expect(uuidv5('www.example.com', DNS_NAMESPACE)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
    expect(uuidv5('www.example.com', URL_NAMESPACE)).toBe('b63cdfa4-3df9-568e-97ae-006c5b8fd652')
  })

  it('hashes the namespace as well as the name', () => {
    expect(uuidv5('www.example.com', DNS_NAMESPACE)).not.toBe(
      uuidv5('www.example.com', URL_NAMESPACE),
    )
  })

  it('reads the namespace as bytes, not as the text it is written in [fence:session-id-namespace-hashed-as-bytes]', () => {
    const why =
      'uuidv5 must hash the sixteen bytes a namespace uuid stands for, never its text (RFC 9562, ' +
      'ADR-0003). Hashed as text, the same namespace written in upper case derives a different ' +
      'id — a difference no reader would suspect, and one that silently orphans every Session ' +
      'derived under the other spelling (#22).'
    expect(uuidv5('x', DNS_NAMESPACE.toUpperCase()), why).toBe(uuidv5('x', DNS_NAMESPACE))
    expect(uuidv5('www.example.com', DNS_NAMESPACE), why).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    )
  })

  it('rejects a namespace that is not a uuid', () => {
    expect(() => uuidv5('x', 'not-a-uuid')).toThrow(/namespace/i)
  })

  it("is what derives a Session id, under roma's own namespace", () => {
    expect(sessionIdFor('conversation-one')).toBe(uuidv5('conversation-one', ROMA_NAMESPACE))
  })
})
