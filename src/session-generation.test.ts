import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionIdFor } from './session-id.js'
import { ChosenModels, SessionGenerations } from './session-generation.js'

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

/** The model roma runs on where nobody has chosen anything. */
const PINNED = 'claude-sonnet-5'
const SESSION = sessionIdFor(KEY)

function models(): ChosenModels {
  return new ChosenModels({ workRoot, pinnedModel: PINNED })
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
  // context `/clear` was used to drop — the stale answers coming back, with
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
  // never used `/clear` — and only it means the first generation. A read that
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

/**
 * The Chosen Model, in the two places seam 1 cannot reach.
 *
 * What a Caller can observe about choosing a model — that the next Turn runs on
 * it, that a reset puts it back, that it survives a restart — is asserted against
 * a whole roma in `core.test.ts`, because that is where it is observable. These
 * two are not: one is a state only a machine that lost power mid-write produces,
 * and the other is a property of the shape of the record rather than of anything
 * roma does with it.
 */
describe('the model a Session runs on', () => {
  // Fail loudly rather than fall back to the Pinned Model. Falling back is a
  // Chosen Model disappearing silently — the Session runs on something nobody
  // asked for, bills the window everybody shares for it, and the only evidence
  // is answers that read as if they came from somewhere else.
  it('refuses to guess when the record it kept is not readable', () => {
    models().choose(SESSION, 'claude-opus-5')
    writeFileSync(join(workRoot, `${SESSION}.model`), '{"half a wr')

    expect(() => models().modelFor(SESSION)).toThrow(/chosen model/i)
  })

  // The same refusal, for the case that is somebody's decision rather than a
  // machine's accident: a name roma has stopped offering is not passed through to
  // `--model`, so removing a Menu entry is a change somebody notices rather than
  // a Session quietly going on running on something the Menu no longer stands
  // behind.
  it('refuses a model roma no longer offers', () => {
    writeFileSync(join(workRoot, `${SESSION}.model`), 'claude-something-else')

    expect(() => models().modelFor(SESSION)).toThrow(/offers/i)
  })

  // "There is no record" is one specific failure — every Session nobody has
  // moved, which is almost all of them — and only it means the Pinned Model. A
  // read that failed for any other reason describes a record that is there and
  // could not be read.
  it('refuses to guess when the record cannot be read at all', () => {
    mkdirSync(join(workRoot, `${SESSION}.model`))

    expect(() => models().modelFor(SESSION)).toThrow()
    expect(models().modelFor(sessionIdFor(OTHER_KEY))).toBe(PINNED)
  })

  // A file rather than a directory, which is the whole of why a Chosen Model
  // outlives the working directory's seven days: `reclaimIdleWorkDirs` deletes
  // directories nothing has used and steps over everything else. Reclaimed, a
  // Conversation that went quiet for a week would come back on the Pinned Model
  // having asked for something else, at a moment nobody can observe.
  it('is a file, so the reclaim that empties the work root steps over it', () => {
    models().choose(SESSION, 'claude-opus-5')

    const written = readdirSync(workRoot, { withFileTypes: true })
    expect(written.map((entry) => entry.name)).toEqual([`${SESSION}.model`])
    expect(written.every((entry) => entry.isFile())).toBe(true)
  })
})
