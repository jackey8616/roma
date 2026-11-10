import { describe, expect, it } from 'vitest'
import { FreshTokens } from './fresh-tokens.js'
import { FakeMinter } from '../test/support/fake-minter.js'

const HOUR_MS = 60 * 60_000

function tokensAt(start = 1_000_000) {
  let now = start
  const minter = new FakeMinter({ now: () => now })
  return {
    minter,
    tokens: new FreshTokens({ minter, now: () => now }),
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('keeping one Installation Token for as long as it is worth keeping', () => {
  it('mints once and serves everybody from it', async () => {
    const { tokens, minter } = tokensAt()

    const served = await Promise.all([tokens.current(), tokens.current(), tokens.current()])

    expect(served).toEqual(['token-1', 'token-1', 'token-1'])
    expect(minter.minted).toHaveLength(1)
  })

  it('refreshes before expiry rather than at it', async () => {
    const { tokens, minter, advance } = tokensAt()
    await tokens.current()

    advance(HOUR_MS - 4 * 60_000)

    expect(await tokens.current()).toBe('token-2')
    expect(minter.minted).toHaveLength(2)
  })

  it('keeps serving a token that has plenty of life left', async () => {
    const { tokens, minter, advance } = tokensAt()
    await tokens.current()

    advance(30 * 60_000)

    expect(await tokens.current()).toBe('token-1')
    expect(minter.minted).toHaveLength(1)
  })

  it('mints once however many callers arrive during the refresh', async () => {
    const { tokens, minter } = tokensAt()

    const served = await Promise.all([tokens.current(), tokens.current()])

    expect(new Set(served).size).toBe(1)
    expect(minter.minted).toHaveLength(1)
  })
})

describe('a token the forge has rejected', () => {
  it('is discarded, so the next request mints', async () => {
    const { tokens, minter } = tokensAt()
    const first = await tokens.current()

    tokens.discard(first)

    expect(await tokens.current()).toBe('token-2')
    expect(minter.minted).toHaveLength(2)
  })

  it('leaves the current one alone when it is an older token being rejected [fence:session-token-discard-is-narrow]', async () => {
    const { tokens, minter, advance } = tokensAt()
    const first = await tokens.current()
    advance(HOUR_MS - 60_000)
    const second = await tokens.current()
    expect(second).not.toBe(first)

    tokens.discard(first)

    expect(await tokens.current(), DISCARD_IS_NARROW).toBe(second)
    expect(minter.minted, DISCARD_IS_NARROW).toHaveLength(2)
  })
})

const DISCARD_IS_NARROW =
  'discard must drop only the token it names, and at most once a cooldown (ADR-0008). An ' +
  'erase can name a token a refresh already replaced, and dropping whatever is held then ' +
  "re-mints on somebody else's stale news; and one token serves every Session, so a 404 " +
  'loop on a repository the Installation does not reach would otherwise discard everybody’s ' +
  'token once per attempt.'

describe('a rejection that is not about the credential', () => {
  it('is honoured once and then ignored for a while [fence:session-token-discard-is-narrow]', async () => {
    const { tokens, minter, advance } = tokensAt()
    const first = await tokens.current()

    tokens.discard(first)
    const second = await tokens.current()
    tokens.discard(second)
    advance(5_000)

    expect(await tokens.current(), DISCARD_IS_NARROW).toBe(second)
    expect(minter.minted, DISCARD_IS_NARROW).toHaveLength(2)
  })

  it('is honoured again once the cooldown has passed', async () => {
    const { tokens, minter, advance } = tokensAt()
    tokens.discard(await tokens.current())
    const second = await tokens.current()
    tokens.discard(second)

    advance(61_000)
    tokens.discard(second)

    expect(await tokens.current()).toBe('token-3')
    expect(minter.minted).toHaveLength(3)
  })
})

describe('when the Minter cannot mint', () => {
  it('rejects with why, rather than with nothing', async () => {
    const { tokens, minter } = tokensAt()
    minter.failsWith = new Error('the App private key was rejected')

    await expect(tokens.current()).rejects.toThrow('the App private key was rejected')
  })

  it('lets the next request try again [fence:session-token-failed-mint-is-forgotten]', async () => {
    const why =
      'A mint that failed must be cleared from in-flight whichever way it went (#62): kept, it ' +
      'is handed to every later caller as a rejection they can do nothing about, even after ' +
      'the App comes back.'
    const { tokens, minter } = tokensAt()
    minter.failsWith = new Error('the App is unreachable')
    await expect(tokens.current()).rejects.toThrow()

    minter.failsWith = null

    expect(await tokens.current(), why).toBe('token-1')
  })
})
