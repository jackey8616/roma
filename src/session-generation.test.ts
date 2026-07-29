import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionIdFor } from './session-id.js'
import { SessionGenerations } from './session-generation.js'

const KEY = 'conversation-one'
const OTHER_KEY = 'conversation-two'

let workRoot: string

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'roma-generations-'))
})

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true })
})

function generations(): SessionGenerations {
  return new SessionGenerations({ workRoot })
}

describe('the Session a Conversation is on', () => {
  it('is the first generation until something rotates it', () => {
    expect(generations().sessionFor(KEY)).toBe(sessionIdFor(KEY))
  })

  it('is a Session of its own, not one shared with another Conversation', () => {
    expect(generations().sessionFor(KEY)).not.toBe(generations().sessionFor(OTHER_KEY))
  })

  // The same guard `sessionIdFor` has, and for the same reason: a key an Adapter
  // bug emptied would otherwise collapse every Conversation into one Session.
  it('refuses an empty Conversation Key', () => {
    expect(() => generations().sessionFor('')).toThrow(/conversation key/i)
    expect(() => generations().freshSession('')).toThrow(/conversation key/i)
  })
})

describe('starting a fresh Session', () => {
  it('gives the Conversation a Session it has never used', () => {
    const sessions = generations()
    const before = sessions.sessionFor(KEY)

    const fresh = sessions.freshSession(KEY)

    expect(fresh).not.toBe(before)
    expect(sessions.sessionFor(KEY)).toBe(fresh)
  })

  it('can be done again, and again reaches somewhere new', () => {
    const sessions = generations()

    const first = sessions.freshSession(KEY)
    const second = sessions.freshSession(KEY)

    expect(new Set([sessionIdFor(KEY), first, second]).size).toBe(3)
  })

  it('moves only the Conversation that asked for it', () => {
    const sessions = generations()

    sessions.freshSession(KEY)

    expect(sessions.sessionFor(OTHER_KEY)).toBe(sessionIdFor(OTHER_KEY))
  })

  // The point of writing this down rather than holding it in memory. A restart
  // that forgot which Session a Conversation was on would resume the very
  // context `/new` was used to drop — the stale answers coming back, with
  // nothing in the Conversation explaining why.
  it("is still the Conversation's Session after roma has restarted", () => {
    const fresh = generations().freshSession(KEY)

    expect(generations().sessionFor(KEY)).toBe(fresh)
  })

  // The working directory is what the Session Pool reads to decide between
  // `--session-id` and `--resume`. A directory created here would make the next
  // spawn resume a Session Claude Code has never heard of.
  it('leaves the working directory to the Session Pool', () => {
    generations().freshSession(KEY)

    expect(readdirSync(workRoot, { withFileTypes: true }).filter((e) => e.isDirectory())).toEqual(
      [],
    )
  })

  // Fail loudly rather than fall back to the first generation: falling back
  // would hand the Conversation the context it asked to be rid of, and the only
  // sign of it would be Claude Code remembering things it should not.
  it('refuses to guess when the record it kept is not readable', () => {
    const sessions = generations()
    sessions.freshSession(KEY)
    writeFileSync(join(workRoot, `${sessionIdFor(KEY)}.generation`), 'half a wr')

    expect(() => sessions.sessionFor(KEY)).toThrow(/generation/i)
  })

  // "There is no record" is one specific failure — every conversation that has
  // never used `/new` — and only it means the first generation. A read that
  // failed for any other reason describes a record that is there and could not
  // be read, and answering the first generation to that is the same silent
  // resurrection by another route.
  it('refuses to guess when the record cannot be read at all', () => {
    const sessions = generations()
    mkdirSync(join(workRoot, `${sessionIdFor(KEY)}.generation`))

    expect(() => sessions.sessionFor(KEY)).toThrow()
    expect(sessions.sessionFor(OTHER_KEY)).toBe(sessionIdFor(OTHER_KEY))
  })
})
