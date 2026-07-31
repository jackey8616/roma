import { describe, expect, it } from 'vitest'
import { FreshTokens } from './fresh-tokens.js'
import { FakeMinter } from '../test/support/fake-minter.js'

/**
 * The arithmetic between a Minter and whatever asks it for a credential, against
 * a fake clock.
 *
 * Every decision here is about *when* rather than about a provider, which is why
 * it is Core code with a Core test: mint rarely, refresh before expiry rather
 * than at it, never mint twice for one gap, and drop what has been rejected. All
 * four are the difference between a credential that works for an hour and one
 * that dies in the middle of somebody's clone.
 *
 * Asserted here against an Installation Token because that is the credential the
 * numbers were chosen for. A Cloud Token gets the same class and therefore the
 * same four rules — `src/shim-server.test.ts` is where that is observed from
 * outside, over a real socket.
 */

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
  // Story 28: ordinary git traffic must not add a network round trip to every
  // operation, or run the App into a rate limit. `git` asks on every operation
  // and `gh` asks on every invocation.
  it('mints once and serves everybody from it', async () => {
    const { tokens, minter } = tokensAt()

    const served = await Promise.all([tokens.current(), tokens.current(), tokens.current()])

    expect(served).toEqual(['token-1', 'token-1', 'token-1'])
    expect(minter.minted).toHaveLength(1)
  })

  // The refresh happens while the old token is still good, so a clone started
  // just before the hour is up does not get a credential that dies inside it —
  // and a mint that fails has not already left roma with nothing.
  it('refreshes before expiry rather than at it', async () => {
    const { tokens, minter, advance } = tokensAt()
    await tokens.current()

    // Fifty-six minutes in: four minutes of life left, which is inside the
    // margin.
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

  // Three Tasks run at once by design, and one agent can start as many `git`
  // processes as it likes inside one. Without single-flight the first request
  // after an hour of quiet becomes several concurrent mints.
  it('mints once however many callers arrive during the refresh', async () => {
    const { tokens, minter } = tokensAt()

    const served = await Promise.all([tokens.current(), tokens.current()])

    expect(new Set(served).size).toBe(1)
    expect(minter.minted).toHaveLength(1)
  })
})

describe('a token the forge has rejected', () => {
  // Without this a rotated or revoked App produces an hour of identical
  // failures, because roma would go on serving the token it still believes in.
  it('is discarded, so the next request mints', async () => {
    const { tokens, minter } = tokensAt()
    const first = await tokens.current()

    tokens.discard(first)

    expect(await tokens.current()).toBe('token-2')
    expect(minter.minted).toHaveLength(2)
  })

  // An erase can arrive after a refresh has already replaced what it names —
  // one Session handing back a credential another was given before the hour
  // turned. Throwing away the current token because an old one failed would be
  // roma re-minting on somebody else's stale news.
  it('leaves the current one alone when it is an older token being rejected', async () => {
    const { tokens, minter, advance } = tokensAt()
    const first = await tokens.current()
    advance(HOUR_MS - 60_000)
    const second = await tokens.current()
    expect(second).not.toBe(first)

    tokens.discard(first)

    expect(await tokens.current()).toBe(second)
    expect(minter.minted).toHaveLength(2)
  })
})

describe('a rejection that is not about the credential', () => {
  // One token serves every Session, and `git` erases for reasons that have
  // nothing to do with the credential — a repository the Installation does not
  // reach authenticates fine and then 404s. Left unguarded, an agent looping on
  // a name that does not exist mints on every attempt, which is the rate limit
  // this class exists to stay under.
  it('is honoured once and then ignored for a while', async () => {
    const { tokens, minter, advance } = tokensAt()
    const first = await tokens.current()

    tokens.discard(first)
    const second = await tokens.current()
    // The same failing clone, again, seconds later.
    tokens.discard(second)
    advance(5_000)

    expect(await tokens.current()).toBe(second)
    expect(minter.minted).toHaveLength(2)
  })

  // What is given up is bounded: a minute, after which a genuinely dead
  // credential is dropped as usual.
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
  // The reason is the only thing that distinguishes a bad private key from a
  // forge that is down, and it is what the Shim puts in front of the agent.
  it('rejects with why, rather than with nothing', async () => {
    const { tokens, minter } = tokensAt()
    minter.failsWith = new Error('the App private key was rejected')

    await expect(tokens.current()).rejects.toThrow('the App private key was rejected')
  })

  // A failed mint left in flight would be handed to every later caller as a
  // rejection they could do nothing about — including after the App came back.
  it('lets the next request try again', async () => {
    const { tokens, minter } = tokensAt()
    minter.failsWith = new Error('the App is unreachable')
    await expect(tokens.current()).rejects.toThrow()

    minter.failsWith = null

    expect(await tokens.current()).toBe('token-1')
  })
})
