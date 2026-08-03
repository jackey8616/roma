import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkRoot } from './work-root.js'
import { sessionIdFor } from './session-id.js'
import { ChosenEfforts, ChosenModels, SessionGenerations } from './session-generation.js'

const KEY = 'conversation-one'
const OTHER_KEY = 'conversation-two'

let workRoot: string
// The path as well as the Work Root, because the tests that assert on what
// landed on disk build the path themselves rather than asking the Work Root
// where it put things — a test that located a record the way the code does
// would agree with it by construction. Where the file-not-directory rule is
// asserted is `work-root.test.ts`; what is checked here is what these three
// classes do with a record once it is found.
let work: WorkRoot

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'roma-generations-'))
  work = new WorkRoot(workRoot)
})

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true })
})

function generations(): SessionGenerations {
  return new SessionGenerations({ workRoot: work })
}

/** The model roma runs on where nobody has chosen anything. */
const PINNED = 'claude-sonnet-5'
const SESSION = sessionIdFor(KEY)

function models(): ChosenModels {
  return new ChosenModels({ workRoot: work, pinnedModel: PINNED })
}

/** The effort roma runs at where nobody has chosen anything. */
const PINNED_AT = 'high'

function efforts(pinnedEffort = PINNED_AT): ChosenEfforts {
  return new ChosenEfforts({ workRoot: work, pinnedEffort })
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

  // A record is written to a name of its own and renamed onto the live one, so
  // that the reader above is defending against a disk rather than against roma.
  // The property itself — that no reader ever sees a part of a record — is
  // structural and cannot be asserted from here without racing a power cut.
  // What can be: the rename happened, so the name it was written under is gone.
  //
  // Worth pinning because the failure is silent in both directions. A rename
  // that never happened leaves the record missing and the work root filling with
  // `.pending` files, and both readers would report a Conversation that has never
  // used `/clear` — the exact silent resurrection every test above exists for.
  it('leaves the record and nothing beside it', () => {
    const sessions = generations()
    const chosen = models()

    sessions.freshSession(KEY)
    chosen.choose(SESSION, 'claude-opus-5')

    expect(readdirSync(workRoot).filter((name) => name.endsWith('.pending'))).toEqual([])
    expect(readdirSync(workRoot).sort()).toEqual(
      [`${sessionIdFor(KEY)}.generation`, `${SESSION}.model`].sort(),
    )
  })
})

/**
 * The Chosen Model, in the two places seam 1 cannot reach.
 *
 * What a Caller can observe about choosing a model — that the next Turn runs on
 * it, that a reset puts it back, that it survives a restart — is asserted against
 * a whole roma in `core.test.ts`, because that is where it is observable. These
 * two are not: one is a record roma did not write, and the other is a property
 * of the shape of the record rather than of anything roma does with it.
 *
 * "A record roma did not write" is meant literally, and it is what `writeRecord`
 * changed. roma's own writes go through a rename, so a half-written record is no
 * longer something roma can leave behind — which makes the refusal below a
 * defence against a disk, an operator or a restore rather than against roma, and
 * a reason to keep it rather than to drop it.
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

/**
 * The same three rules again, for the effort — and the stakes are higher by one
 * thing that does not appear anywhere in this file.
 *
 * `--model` is echoed in `system/init` and the startup self-check asserts on it,
 * so a Chosen Model that went missing would eventually contradict something.
 * `--effort` is echoed nowhere at all. What is written here is the only account
 * roma has of what a Session was asked to run at, which is why the failures
 * below refuse rather than fall back.
 */
describe('the effort a Session runs at', () => {
  it('is the Pinned Effort until somebody chooses, and writes nothing down for that', () => {
    expect(efforts().effortFor(SESSION)).toBe(PINNED_AT)
    expect(efforts().chosenFor(SESSION)).toBeNull()
    expect(readdirSync(workRoot)).toEqual([])
  })

  it('is what somebody chose, from the moment they chose it', () => {
    efforts().choose(SESSION, 'max')

    expect(efforts().effortFor(SESSION)).toBe('max')
  })

  // The distinction `effortFor` collapses and a report needs: a Session with no
  // record *follows* the Pinned Effort, and one whose record names the same
  // level does not. One string today, two the moment an operator moves
  // `ROMA_EFFORT`.
  it('tells choosing the pinned level apart from never having chosen', () => {
    efforts().choose(SESSION, PINNED_AT)

    expect(efforts().chosenFor(SESSION)).toBe(PINNED_AT)
    // Which is what makes the two answer differently when the deployment moves.
    expect(efforts('low').effortFor(SESSION)).toBe(PINNED_AT)
    expect(efforts('low').effortFor(sessionIdFor(OTHER_KEY))).toBe('low')
  })

  // Forgetting the record rather than writing the pinned level into it. A
  // Session that asked for "default" must follow a deployment that moves
  // `ROMA_EFFORT`; one carrying a literal would be stranded at the effort roma
  // used to run at.
  it('goes back to the Pinned Effort by forgetting, not by writing it down', () => {
    efforts().choose(SESSION, 'max')
    efforts().usePinnedEffort(SESSION)

    expect(efforts('low').effortFor(SESSION)).toBe('low')
    expect(readdirSync(workRoot)).toEqual([])
  })

  it('is happy to go back where nobody ever moved it', () => {
    expect(() => efforts().usePinnedEffort(SESSION)).not.toThrow()
  })

  // Keyed by the Session id, which is what makes `/clear` revert it by
  // arithmetic: the reset moves the generation, so a cleared Conversation asks
  // about a Session id that has no record.
  it('is left behind by the reset, without anything being deleted', () => {
    efforts().choose(SESSION, 'max')
    const fresh = generations().freshSession(KEY)

    expect(efforts().effortFor(fresh)).toBe(PINNED_AT)
    expect(efforts().effortFor(SESSION)).toBe('max')
  })

  it('refuses to guess when the record it kept is not readable', () => {
    writeFileSync(join(workRoot, `${SESSION}.effort`), '{"half a wr')

    expect(() => efforts().effortFor(SESSION)).toThrow(/chosen effort/i)
  })

  // A narrower hole than the model's, because the Effort Menu holds every level
  // the build has — so the only way here is roma *removing* one, which is
  // exactly what this refusal exists to make noticeable.
  it('refuses a level roma no longer offers', () => {
    writeFileSync(join(workRoot, `${SESSION}.effort`), 'ludicrous')

    expect(() => efforts().effortFor(SESSION)).toThrow(/offers/i)
  })

  // `ultracode` reaches roma through `ROMA_EFFORT` and never through a record,
  // so a record naming it is one nothing in roma wrote — and is refused like any
  // other level off the Menu.
  it('refuses a record naming ultracode, which no Caller can have written', () => {
    writeFileSync(join(workRoot, `${SESSION}.effort`), 'ultracode')

    expect(() => efforts().effortFor(SESSION)).toThrow(/offers/i)
  })

  it('refuses to guess when the record cannot be read at all', () => {
    mkdirSync(join(workRoot, `${SESSION}.effort`))

    expect(() => efforts().effortFor(SESSION)).toThrow()
    expect(efforts().effortFor(sessionIdFor(OTHER_KEY))).toBe(PINNED_AT)
  })

  // A file rather than a directory, beside the model's, for the reason the
  // model's is one: `reclaimIdleWorkDirs` deletes directories nothing has used
  // for seven days and steps over everything else.
  it('is a file beside the model’s, so the reclaim steps over both', () => {
    models().choose(SESSION, 'claude-opus-5')
    efforts().choose(SESSION, 'max')

    const written = readdirSync(workRoot, { withFileTypes: true })
    expect(written.map((entry) => entry.name).sort()).toEqual([
      `${SESSION}.effort`,
      `${SESSION}.model`,
    ])
    expect(written.every((entry) => entry.isFile())).toBe(true)
  })
})
