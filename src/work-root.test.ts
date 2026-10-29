import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkRoot } from './work-root.js'

/**
 * A write the power cuts halfway through: half the bytes land, then nothing.
 *
 * Off unless a test turns it on, so every other write here is the real one.
 */
const powerFails = vi.hoisted(() => ({ mid: false }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const writeFileSync: typeof fs.writeFileSync = (file, data, options) => {
    if (!powerFails.mid) return fs.writeFileSync(file, data, options)
    fs.writeFileSync(file, String(data).slice(0, 3), options)
    throw new Error('the power went')
  }
  return { ...fs, writeFileSync }
})

const SURVIVES =
  'Every record roma keeps about a Conversation — generation, Chosen Model, Effort, Caveman, ' +
  'Opening, and a `.pending` — must be a file beside the Working Directories, and the sweep ' +
  'must step over files (#105). The sweep deletes directories idle for seven days: a record ' +
  'that was a directory, or a sweep that took files, would send a quiet Conversation back to ' +
  'the Session `/clear` moved it off, or onto the Pinned Model, Effort or Caveman, or open it ' +
  'again, with nobody told.'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'

let roots: string[] = []

function newRoot(): { root: string; work: WorkRoot } {
  const root = mkdtempSync(join(tmpdir(), 'roma-work-root-'))
  roots.push(root)
  return { root, work: new WorkRoot(root) }
}

/** Make a directory look as though nothing has touched it for `ageMs`. */
function age(path: string, ageMs: number): void {
  const seconds = (Date.now() - ageMs) / 1000
  utimesSync(path, seconds, seconds)
}

/**
 * A Session that has been used, and when.
 *
 * The mtime is moved rather than a clock being handed in, because the mtime is
 * the only clock this module has — see `touch`.
 */
function sessionUsed(work: WorkRoot, id: string, agoMs: number): string {
  const cwd = work.sessionDir(id)
  mkdirSync(cwd, { recursive: true })
  age(cwd, agoMs)
  return cwd
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('where a Session works', () => {
  it('answers for a Session that has never run', () => {
    const { root, work } = newRoot()

    expect(work.sessionDir(A)).toBe(join(root, A))
    expect(existsSync(work.sessionDir(A))).toBe(false)
  })

  // A pure derivation, which is what lets an Enclosure be written before the
  // Turn that reads it (ADR-0011). Creating the directory here is what #105 was:
  // for as long as its existence was the record that a Session had run, asking
  // where a Session works made it look like one that already had.
  it('makes no directory [fence:workroot-session-dir-makes-nothing]', () => {
    const why =
      'sessionDir must be a pure derivation that creates nothing (#105, #107). For as long as ' +
      'a Working Directory’s existence was the record that a Session had run, an Enclosure ' +
      'written before the first Turn made roma --resume a Session it never created.'
    const { root, work } = newRoot()

    work.sessionDir(A)

    expect(readdirSync(root), why).toEqual([])
  })
})

describe('marking a Session as used', () => {
  it('moves the directory the sweep reads', () => {
    const { work } = newRoot()
    sessionUsed(work, A, 8 * DAY)

    work.touch(A)

    expect(work.reclaimIdle(new Set())).toEqual([])
  })

  // A directory reclaimed underneath us is not worth failing a Turn over, and a
  // Turn is exactly what is in flight when this is called.
  it('says nothing about a directory that is gone', () => {
    const { work } = newRoot()

    expect(() => work.touch(A)).not.toThrow()
  })
})

describe('reclaiming what nothing has used', () => {
  it('deletes a working directory idle for more than seven days', () => {
    const { work } = newRoot()
    const cwd = sessionUsed(work, A, 8 * DAY)

    expect(work.reclaimIdle(new Set())).toEqual([{ sessionId: A, cwd, idleMs: expect.any(Number) }])
    expect(existsSync(cwd)).toBe(false)
  })

  it('keeps one that is younger than seven days', () => {
    const { work } = newRoot()
    const cwd = sessionUsed(work, A, 6 * DAY)

    expect(work.reclaimIdle(new Set())).toEqual([])
    expect(existsSync(cwd)).toBe(true)
  })

  // A resident process holds its directory open and a Turn in flight is writing
  // into it. The mtime cannot see either — a Session can be mid-Turn for an hour
  // without anything touching the directory again.
  it('keeps a Session that is resident, however old its directory looks [fence:workroot-in-use-is-required]', () => {
    const why =
      'reclaimIdle must be told which Sessions are in use, and the type must require it (#105): ' +
      'a forgotten argument read as an empty set deletes the directory out from under every ' +
      'running Turn, whose mtime cannot show that a process holds it open.'
    const { work } = newRoot()
    const cwd = sessionUsed(work, A, 30 * DAY)
    // @ts-expect-error -- fence:workroot-in-use-is-required: forgetting inUse must not compile.
    const forgot: () => unknown = () => work.reclaimIdle()

    expect(typeof forgot, why).toBe('function')
    expect(work.reclaimIdle(new Set([A])), why).toEqual([])
    expect(existsSync(cwd), why).toBe(true)
  })

  /**
   * The rule this module exists to hold.
   *
   * Every record roma keeps about a Conversation sits beside these directories
   * as a file — a generation, a Chosen Model, a Chosen Effort, a Chosen Caveman,
   * and the `.pending` a half-written record leaves behind. A sweep that took
   * them would drop a Session's Chosen Model on the floor while the Session was
   * still being talked to, and put a Conversation back on the Pinned Model with
   * nobody told.
   *
   * It used to be one line in the Session Pool and three comments in
   * `session-generation.ts`, in modules that do not import each other. This is
   * the assertion that holds it now.
   */
  it('steps over every file, however old [fence:workroot-records-survive-the-sweep]', () => {
    const { root, work } = newRoot()
    const records = [
      `${A}.generation`,
      `${A}.model`,
      `${A}.effort`,
      `${A}.caveman`,
      `${A}.model.pending`,
    ]
    for (const name of records) {
      const path = join(root, name)
      writeFileSync(path, '1')
      age(path, 400 * DAY)
    }

    expect(work.reclaimIdle(new Set()), SURVIVES).toEqual([])
    expect(readdirSync(root).sort(), SURVIVES).toEqual([...records].sort())
  })

  it('keeps every record roma writes, written its own way [fence:workroot-records-survive-the-sweep]', () => {
    const { root, work } = newRoot()
    const records = [
      work.generationRecord(A),
      work.modelRecord(A),
      work.effortRecord(A),
      work.cavemanRecord(A),
      work.openedRecord(A),
    ]
    for (const record of records) work.writeRecord(record, 'kept')
    for (const entry of readdirSync(root)) age(join(root, entry), 400 * DAY)

    work.reclaimIdle(new Set())

    expect(
      records.map((record) => work.readRecord(record)),
      SURVIVES,
    ).toEqual(records.map(() => 'kept'))
  })

  it('reclaims only what is idle, leaving the rest', () => {
    const { work } = newRoot()
    const stale = sessionUsed(work, A, 8 * DAY)
    const fresh = sessionUsed(work, B, 1 * MINUTE)

    expect(work.reclaimIdle(new Set()).map(({ sessionId }) => sessionId)).toEqual([A])
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  // How long it had been is what the pool's `reclaim` record carries, and the
  // directory is gone by the time anybody could ask.
  it('says how idle each one was', () => {
    const { work } = newRoot()
    sessionUsed(work, A, 9 * DAY)

    const [reclaimed] = work.reclaimIdle(new Set())

    expect(reclaimed?.idleMs).toBeGreaterThanOrEqual(9 * DAY)
    expect(reclaimed?.idleMs).toBeLessThan(10 * DAY)
  })

  // A work root a deployment has not mounted yet, on the first boot. Answering
  // "nothing" is right; throwing would take the hourly timer down with it.
  it('reclaims nothing when the root is not there', () => {
    const { root, work } = newRoot()
    rmSync(root, { recursive: true, force: true })

    expect(work.reclaimIdle(new Set())).toEqual([])
  })
})

describe('where a record goes', () => {
  it('names each record beside the working directories, not inside one', () => {
    const { root, work } = newRoot()

    expect(work.generationRecord(A)).toBe(join(root, `${A}.generation`))
    expect(work.modelRecord(A)).toBe(join(root, `${A}.model`))
    expect(work.effortRecord(A)).toBe(join(root, `${A}.effort`))
    expect(work.cavemanRecord(A)).toBe(join(root, `${A}.caveman`))
    expect(work.openedRecord(A)).toBe(join(root, `${A}.opened`))
  })

  // The rule the sweep enforces, read from the other end: a record is a sibling
  // of the directory it describes and never a child of it, so deleting the
  // directory cannot take it.
  it('puts no record inside the Session directory it describes', () => {
    const { work } = newRoot()

    for (const path of [
      work.generationRecord(A),
      work.modelRecord(A),
      work.effortRecord(A),
      work.cavemanRecord(A),
      work.openedRecord(A),
    ]) {
      expect(path.startsWith(`${work.sessionDir(A)}/`)).toBe(false)
    }
  })
})

describe('reading a record', () => {
  it('answers null where there is none, which is almost every Session', () => {
    const { work } = newRoot()

    expect(work.readRecord(work.modelRecord(A))).toBeNull()
  })

  it('trims what it read, so no caller has to remember to', () => {
    const { work } = newRoot()
    work.writeRecord(work.modelRecord(A), 'claude-sonnet-5\n')

    expect(work.readRecord(work.modelRecord(A))).toBe('claude-sonnet-5')
  })

  /**
   * The distinction the whole fallback rule rests on.
   *
   * A record that may exist and cannot be read is not the same as one nobody
   * wrote. Answering "none" to both is how a Chosen Model disappears with nobody
   * told — the Conversation quietly returns to the Pinned Model, and the only
   * evidence is a bill.
   */
  it('throws where a record exists and cannot be read [fence:workroot-unreadable-is-not-missing]', () => {
    const why =
      'readRecord may answer null only for a record that is not there (ENOENT); every other ' +
      'failure must throw. A record that may exist and cannot be read is not one nobody wrote, ' +
      'and answering "none" to both is how a Chosen Model silently disappears.'
    const { work } = newRoot()
    mkdirSync(work.modelRecord(A), { recursive: true })

    expect(() => work.readRecord(work.modelRecord(A)), why).toThrow()
  })
})

describe('writing a record', () => {
  it('makes the root a deployment has not mounted yet', () => {
    const { root, work } = newRoot()
    rmSync(root, { recursive: true, force: true })

    work.writeRecord(work.generationRecord(A), '1')

    expect(work.readRecord(work.generationRecord(A))).toBe('1')
  })

  // A rename within one directory is atomic, so a reader sees the old record or
  // the new one and never a part of either.
  it('leaves nothing half-written behind it', () => {
    const { root, work } = newRoot()

    work.writeRecord(work.modelRecord(A), 'claude-sonnet-5')

    expect(readdirSync(root)).toEqual([`${A}.model`])
  })

  it('leaves the record whole when the power goes mid-write [fence:workroot-record-write-is-atomic]', () => {
    const why =
      'writeRecord must write a temporary name and rename it over the record, never write the ' +
      'live name: a machine that loses power mid-write leaves a torn record, which every reader ' +
      'rightly refuses, and the Conversation’s thread stops working for a write nobody got wrong.'
    const { work } = newRoot()
    work.writeRecord(work.modelRecord(A), 'claude-sonnet-5')

    powerFails.mid = true
    try {
      expect(() => work.writeRecord(work.modelRecord(A), 'claude-opus-5')).toThrow('power')
    } finally {
      powerFails.mid = false
    }

    expect(work.readRecord(work.modelRecord(A)), why).toBe('claude-sonnet-5')
  })

  it('replaces a record rather than appending to it', () => {
    const { work } = newRoot()
    work.writeRecord(work.effortRecord(A), 'high')

    work.writeRecord(work.effortRecord(A), 'low')

    expect(work.readRecord(work.effortRecord(A))).toBe('low')
  })
})

describe('forgetting a record', () => {
  it('removes one', () => {
    const { work } = newRoot()
    work.writeRecord(work.modelRecord(A), 'claude-sonnet-5')

    work.forgetRecord(work.modelRecord(A))

    expect(work.readRecord(work.modelRecord(A))).toBeNull()
  })

  // `/model default` on a Session nobody ever moved. There is nothing to delete
  // and that is exactly the state being asked for.
  it('says nothing where there was no record', () => {
    const { work } = newRoot()

    expect(() => work.forgetRecord(work.modelRecord(A))).not.toThrow()
  })

  /**
   * Deliberately not recursive.
   *
   * A directory where a record should be is something roma did not put there and
   * cannot read. Removing it quietly would have the Command answer that it moved
   * a Session it did not.
   */
  it('refuses to remove a directory standing where a record should be [fence:workroot-forget-is-not-recursive]', () => {
    const why =
      'forgetRecord must not be recursive: a directory where a record should be is something ' +
      'roma did not put there, and removing it quietly would have the Command answer that it ' +
      'moved a Session it did not.'
    const { work } = newRoot()
    mkdirSync(work.modelRecord(A), { recursive: true })

    expect(() => work.forgetRecord(work.modelRecord(A)), why).toThrow()
    expect(existsSync(work.modelRecord(A)), why).toBe(true)
  })
})
