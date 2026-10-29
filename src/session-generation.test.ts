import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkRoot } from './work-root.js'
import { sessionIdFor } from './session-id.js'
import {
  chosenCavemen,
  chosenEfforts,
  chosenModels,
  SessionGenerations,
  type ChosenKind,
  type ChosenRecord,
} from './session-generation.js'

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

function models(pinnedModel = PINNED): ChosenRecord<'model'> {
  return chosenModels({ workRoot: work, pinnedModel })
}

/** The effort roma runs at where nobody has chosen anything. */
const PINNED_AT = 'high'

function efforts(pinnedEffort = PINNED_AT): ChosenRecord<'effort'> {
  return chosenEfforts({ workRoot: work, pinnedEffort })
}

/**
 * The Caveman roma runs at where nobody has chosen anything.
 *
 * A level rather than `off`, so that the two words a Caller may type for "leave
 * me alone" stay apart in every case below: `off` is a level this record may
 * name, and `default` is the absence of a record.
 */
const PINNED_SHORT = 'full'

function cavemen(pinnedCaveman = PINNED_SHORT): ChosenRecord<'caveman'> {
  return chosenCavemen({ workRoot: work, pinnedCaveman })
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

  it('can be done again, and again reaches somewhere new [fence:session-generation-filed-under-first-id]', () => {
    const sessions = generations()

    const first = sessions.freshSession(KEY)
    const second = sessions.freshSession(KEY)

    expect(new Set([sessionIdFor(KEY), first, second]).size, FILED_UNDER_FIRST_ID).toBe(3)
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
  it("is still the Conversation's Session after roma has restarted [fence:session-generation-kept-on-disk]", () => {
    const why =
      "A Conversation's Session generation must be kept on disk, never in memory (ADR-0003, " +
      'Where a fresh session comes from). Held in memory, a /clear survives until the next ' +
      'deploy and is then silently undone: the Conversation resumes the Transcript it asked to ' +
      'be rid of, and the only evidence is Claude Code remembering what should be gone.'
    const fresh = generations().freshSession(KEY)

    expect(generations().sessionFor(KEY), why).toBe(fresh)
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
  it('refuses to guess when the record it kept is not readable [fence:session-generation-refuses-to-guess]', () => {
    const sessions = generations()
    sessions.freshSession(KEY)
    writeFileSync(join(workRoot, `${sessionIdFor(KEY)}.generation`), 'half a wr')

    expect(() => sessions.sessionFor(KEY), GENERATION_REFUSES_TO_GUESS).toThrow(/generation/i)
  })

  // "There is no record" is one specific failure — every conversation that has
  // never used `/clear` — and only it means the first generation. A read that
  // failed for any other reason describes a record that is there and could not
  // be read, and answering the first generation to that is the same silent
  // resurrection by another route.
  it('refuses to guess when the record cannot be read at all [fence:session-generation-refuses-to-guess]', () => {
    const sessions = generations()
    mkdirSync(join(workRoot, `${sessionIdFor(KEY)}.generation`))

    expect(() => sessions.sessionFor(KEY), GENERATION_REFUSES_TO_GUESS).toThrow()
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
  it('leaves the record and nothing beside it [fence:session-generation-filed-under-first-id]', () => {
    const sessions = generations()
    const chosen = models()

    sessions.freshSession(KEY)
    chosen.choose(SESSION, 'claude-opus-5')

    expect(readdirSync(workRoot).filter((name) => name.endsWith('.pending'))).toEqual([])
    expect(readdirSync(workRoot).sort(), FILED_UNDER_FIRST_ID).toEqual(
      [`${sessionIdFor(KEY)}.generation`, `${SESSION}.model`].sort(),
    )
  })
})

const FILED_UNDER_FIRST_ID =
  "A Conversation's generation record must be filed under its first generation's Session " +
  'id, never the current one (ADR-0003, Where a fresh session comes from). The record has ' +
  'to be findable from the Conversation Key alone, and the current generation is the thing ' +
  'being looked for; filed under it, the record is never found and /clear reverts.'

const GENERATION_REFUSES_TO_GUESS =
  'A generation record that exists and cannot be read must throw, never fall back to ' +
  'generation zero (ADR-0003, Where a fresh session comes from). Zero is the Session the ' +
  'Conversation used /clear to leave, so falling back hands it back the context it asked to ' +
  'be rid of, silently.'

/**
 * The Chosen Model, in the two places seam 1 cannot reach.
 *
 * What a Caller can observe about choosing a model — that the next Turn runs on
 * it, that a reset puts it back, that it survives a restart — is asserted against
 * a whole roma in `core.test.ts`, because that is where it is observable. These
 * two are not: one is a record roma did not write, and the other is a property
 * of the shape of the record rather than of anything roma does with it.
 *
 * "A record roma did not write" is meant literally, and it is what `WorkRoot.writeRecord`
 * changed. roma's own writes go through a rename, so a half-written record is no
 * longer something roma can leave behind — which makes the refusal below a
 * defence against a disk, an operator or a restore rather than against roma, and
 * a reason to keep it rather than to drop it.
 */
/**
 * The rules every Chosen Record keeps, whichever of the three it is.
 *
 * Written once and run once per kind, because the record is written once and
 * used three times — and because the first two suites had already drifted apart
 * while those classes were separate: the effort's asserted six things the
 * model's did not, on an implementation that was byte-identical.
 *
 * Only what is genuinely shared. `ultracode`, the wenyan levels, and the records
 * sitting beside each other, are each one kind's own and stay in its own block
 * below.
 */
function behavesLikeAChosenRecord({
  make,
  suffix,
  pinned,
  otherPinned,
  chosen,
  offMenu,
  refusal,
}: {
  make: (pinned?: string) => ChosenRecord<ChosenKind>
  suffix: string
  pinned: string
  otherPinned: string
  chosen: string
  offMenu: string
  refusal: RegExp
}): void {
  // Built inside each case rather than here: `workRoot` is minted by `beforeEach`
  // and this function body runs while vitest is still collecting.
  const record = (): string => join(workRoot, `${SESSION}${suffix}`)

  it('is the pinned one until somebody chooses, and writes nothing down for that', () => {
    expect(make().inForce(SESSION)).toBe(pinned)
    expect(make().chosenFor(SESSION)).toBeNull()
    expect(readdirSync(workRoot)).toEqual([])
  })

  it('is what somebody chose, from the moment they chose it', () => {
    make().choose(SESSION, chosen)

    expect(make().inForce(SESSION)).toBe(chosen)
  })

  // The distinction `inForce` collapses and a report needs: a Session with no
  // record *follows* the pinned value, and one whose record names that same
  // value does not. One string today, two the moment an operator moves it.
  it('tells choosing the pinned one apart from never having chosen [fence:session-chosen-pinned-is-still-chosen]', () => {
    const why =
      'chosenFor must report a record naming the pinned value as that value, and only a ' +
      'missing record as null (ADR-0014, ADR-0016). The two are one string today and two the ' +
      'moment an operator moves ROMA_MODEL or ROMA_EFFORT; a report calling both "default" ' +
      'tells somebody who typed /model sonnet they follow whatever the deployment picks next.'
    make().choose(SESSION, pinned)

    expect(make().chosenFor(SESSION), why).toBe(pinned)
    // Which is what makes the two answer differently when the deployment moves.
    expect(make(otherPinned).inForce(SESSION), why).toBe(pinned)
    expect(make(otherPinned).inForce(sessionIdFor(OTHER_KEY))).toBe(otherPinned)
  })

  it('goes back to the pinned one by forgetting, not by writing it down [fence:session-default-forgets]', () => {
    const why =
      '`default` must forget the record, never write the pinned value into it (ADR-0014, ' +
      'ADR-0016). A Session that asked for "default" must follow a deployment that moves ' +
      'ROMA_MODEL or ROMA_EFFORT; one carrying a literal is stranded on what roma used to run.'
    make().choose(SESSION, chosen)
    make().usePinned(SESSION)

    expect(make(otherPinned).inForce(SESSION), why).toBe(otherPinned)
    expect(readdirSync(workRoot), why).toEqual([])
  })

  it('is happy to go back where nobody ever moved it', () => {
    expect(() => make().usePinned(SESSION)).not.toThrow()
  })

  // Keyed by the Session id, which is what makes `/clear` revert it by
  // arithmetic: the reset moves the generation, so a cleared Conversation asks
  // about a Session id that has no record.
  it('is left behind by the reset, without anything being deleted [fence:session-choice-keyed-by-session-id]', () => {
    make().choose(SESSION, chosen)
    const fresh = generations().freshSession(KEY)

    expect(make().inForce(fresh), KEYED_BY_SESSION_ID).toBe(pinned)
    expect(make().inForce(SESSION), KEYED_BY_SESSION_ID).toBe(chosen)
  })

  // Fail loudly rather than fall back. Falling back is a choice disappearing
  // silently — the Session runs on something nobody asked for, bills the window
  // everybody shares for it, and the only evidence is answers that read as if
  // they came from somewhere else.
  it('refuses to guess when the record it kept is not readable [fence:session-choice-refuses-to-guess]', () => {
    writeFileSync(record(), '{"half a wr')

    expect(() => make().inForce(SESSION), CHOICE_REFUSES_TO_GUESS).toThrow(refusal)
  })

  // The same refusal, for the case that is somebody's decision rather than a
  // machine's accident.
  it('refuses one roma no longer offers [fence:session-record-names-only-the-menu]', () => {
    writeFileSync(record(), offMenu)

    expect(() => make().inForce(SESSION), NAMES_ONLY_THE_MENU).toThrow(/offers/i)
  })

  // "There is no record" is one specific failure — every Session nobody has
  // moved, which is almost all of them — and only it means the pinned value. A
  // read that failed for any other reason describes a record that is there and
  // could not be read.
  it('refuses to guess when the record cannot be read at all [fence:session-choice-refuses-to-guess]', () => {
    mkdirSync(record())

    expect(() => make().inForce(SESSION), CHOICE_REFUSES_TO_GUESS).toThrow()
    expect(make().inForce(sessionIdFor(OTHER_KEY))).toBe(pinned)
  })

  // An operator may pin something off the Menu — `ultracode`, a wenyan level, a
  // model id the Menu does not carry — and the Menu bounds Callers, never them.
  it('runs on a pinned value the Menu does not offer [fence:session-pinned-is-not-gated]', () => {
    const why =
      '`offered` must gate the record and never the pinned value (ADR-0016, ADR-0030). An ' +
      'operator may pin something off the Menu, ROMA_EFFORT=ultracode being the live case, ' +
      'and that deployment must go on running while a record naming it is still refused; ' +
      'gated, every Session on it stops.'

    expect(make(offMenu).inForce(SESSION), why).toBe(offMenu)
    writeFileSync(record(), offMenu)
    expect(() => make(offMenu).inForce(SESSION), why).toThrow(/offers/i)
  })

  // A file rather than a directory, which is the whole of why a choice outlives
  // the working directory's seven days: `reclaimIdle` deletes directories
  // nothing has used and steps over everything else. Reclaimed, a Conversation
  // that went quiet for a week would come back on the pinned value having asked
  // for something else, at a moment nobody can observe.
  it('is a file, so the reclaim that empties the work root steps over it [fence:session-choice-keyed-by-session-id]', () => {
    make().choose(SESSION, chosen)

    const written = readdirSync(workRoot, { withFileTypes: true })
    expect(
      written.map((entry) => entry.name),
      KEYED_BY_SESSION_ID,
    ).toEqual([`${SESSION}${suffix}`])
    expect(
      written.every((entry) => entry.isFile()),
      KEYED_BY_SESSION_ID,
    ).toBe(true)
  })
}

const KEYED_BY_SESSION_ID =
  'A Chosen record must be a file in the Work Root keyed by the Session id, never by the ' +
  'Conversation Key and never in the Working Directory (ADR-0014). The reset moves the ' +
  'generation, so a record keyed by Session id reverts by arithmetic; keyed by the ' +
  'Conversation Key, the context is cleared and the model still Opus. In the Working ' +
  'Directory it is git-added by the agent (ADR-0008) and reclaimed after seven idle days.'

const CHOICE_REFUSES_TO_GUESS =
  'A Chosen record that exists and cannot be read must throw, never fall back to the pinned ' +
  'value (ADR-0014). Only a missing record means the pinned value; falling back on anything ' +
  'else runs the Session on something nobody chose and bills the Shared Window for it.'

const NAMES_ONLY_THE_MENU =
  'A Chosen record may name only what the Menu offers, by membership and never by pattern ' +
  '(ADR-0014, story 38). A record roma has stopped offering, or one only an operator may pin, ' +
  'is refused rather than passed through to the CLI, so removing a Menu entry is noticed ' +
  'instead of a Session quietly running on what the Menu no longer stands behind.'

describe('the model a Session runs on', () => {
  behavesLikeAChosenRecord({
    make: models,
    suffix: '.model',
    pinned: PINNED,
    otherPinned: 'claude-haiku-4-5',
    chosen: 'claude-opus-5',
    offMenu: 'claude-something-else',
    refusal: /chosen model/i,
  })
})

/**
 * The same rules again, for the effort — and the stakes are higher by one thing
 * that does not appear anywhere in this file.
 *
 * `--model` is echoed in `system/init` and the startup self-check asserts on it,
 * so a Chosen Model that went missing would eventually contradict something.
 * `--effort` is echoed nowhere at all. What is written here is the only account
 * roma has of what a Session was asked to run at, which is why the failures
 * refuse rather than fall back.
 */
describe('the effort a Session runs at', () => {
  behavesLikeAChosenRecord({
    make: efforts,
    suffix: '.effort',
    pinned: PINNED_AT,
    otherPinned: 'low',
    chosen: 'max',
    offMenu: 'ludicrous',
    refusal: /chosen effort/i,
  })

  // `ultracode` reaches roma through `ROMA_EFFORT` and never through a record,
  // so a record naming it is one nothing in roma wrote — and is refused like any
  // other level off the Menu. The model has no equivalent: every Pinned Model
  // roma accepts is one a record may also name.
  it('refuses a record naming ultracode, which no Caller can have written [fence:session-record-names-only-the-menu]', () => {
    writeFileSync(join(workRoot, `${SESSION}.effort`), 'ultracode')

    expect(() => efforts().inForce(SESSION), NAMES_ONLY_THE_MENU).toThrow(/offers/i)
  })

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

/**
 * The same rules a third time, for the Caveman — written once and run three
 * times, which is the whole argument ADR-0030 makes for a third adapter over a
 * third class. The first two had already drifted in what each was tested for
 * while they were separate; this is the ticket that stops that happening again.
 *
 * The stakes are a third kind. A Chosen Model that went missing would eventually
 * contradict `system/init`, and a Chosen Effort would contradict nothing at all
 * — but this one has a witness nobody can read: the Session goes on answering,
 * in prose that is the wrong length, and the only evidence is that roma sounds
 * different from the message before.
 */
describe('the Caveman a Session runs at', () => {
  behavesLikeAChosenRecord({
    make: cavemen,
    suffix: '.caveman',
    pinned: PINNED_SHORT,
    otherPinned: 'lite',
    chosen: 'ultra',
    offMenu: 'wenyan',
    refusal: /chosen caveman/i,
  })

  // The two levels an operator may pin and no Caller may choose. They reach roma
  // through `ROMA_CAVEMAN` and never through a record, so a record naming one is
  // one nothing in roma wrote — `ultracode`'s case exactly, and there are two of
  // them here.
  it('refuses a record naming a wenyan level no Caller can have written [fence:session-record-names-only-the-menu]', () => {
    for (const level of ['wenyan-lite', 'wenyan-ultra']) {
      writeFileSync(join(workRoot, `${SESSION}.caveman`), level)

      expect(() => cavemen().inForce(SESSION), NAMES_ONLY_THE_MENU).toThrow(/offers/i)
    }
  })

  // `off` is a level a Caller may choose and so a value a record may name, which
  // is what tells it apart from `default` — the name that means "follow the
  // deployment" and is written down as no record at all.
  it('keeps off, which is a level, apart from having chosen nothing [fence:session-caveman-off-is-a-level]', () => {
    const why =
      '`off` must stay among the Cavemen a record may name (ADR-0030). It is a level a Caller ' +
      'may choose, and `default` is the one written down as no record. Dropped as meaning ' +
      '"no record", a Caller who asked to be left alone on a deployment that pinned a ' +
      'Caveman has every message they send afterwards refused.'
    cavemen().choose(SESSION, 'off')

    expect(() => cavemen().chosenFor(SESSION), why).not.toThrow()
    expect(cavemen().chosenFor(SESSION), why).toBe('off')
    expect(cavemen('ultra').inForce(SESSION), why).toBe('off')
  })

  it('is a file beside the other two, so the reclaim steps over all three', () => {
    models().choose(SESSION, 'claude-opus-5')
    efforts().choose(SESSION, 'max')
    cavemen().choose(SESSION, 'ultra')

    const written = readdirSync(workRoot, { withFileTypes: true })
    expect(written.map((entry) => entry.name).sort()).toEqual([
      `${SESSION}.caveman`,
      `${SESSION}.effort`,
      `${SESSION}.model`,
    ])
    expect(written.every((entry) => entry.isFile())).toBe(true)
  })
})

describe('the three kinds of Chosen Record', () => {
  // `CoreOptions` holds the three in adjacent fields. The directives below are the
  // check: each is an error only while `kind` makes the kinds differ, so a
  // `ChosenRecord` that lost it fails `npm run typecheck` with TS2578.
  it('cannot be handed over as one another [fence:session-chosen-kinds-do-not-swap]', () => {
    const why =
      '`kind` must stay a member of ChosenRecord (ADR-0030). Without a member naming K, ' +
      "ChosenRecord<'model'>, <'effort'> and <'caveman'> are structurally identical, so " +
      'swapping two adjacent CoreOptions fields compiles clean and a Conversation is told the ' +
      'effort it runs at as the model it runs on. Empty named subclasses do not fix it: they ' +
      'share the class #private and add nothing structural.'
    const model = models()
    const effort = efforts()

    // @ts-expect-error -- an effort record is not a model record
    const asModel: ChosenRecord<'model'> = effort
    // @ts-expect-error -- a model record is not a Caveman record
    const asCaveman: ChosenRecord<'caveman'> = model

    expect([model.kind, effort.kind, cavemen().kind], why).toEqual(['model', 'effort', 'caveman'])
    expect(asModel.kind, why).not.toBe('model')
    expect(asCaveman.kind, why).not.toBe('caveman')
  })
})
