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
import { afterEach, describe, expect, it } from 'vitest'
import { WorkRoot } from './work-root.js'

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
  it('makes no directory', () => {
    const { root, work } = newRoot()

    work.sessionDir(A)

    expect(readdirSync(root)).toEqual([])
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

    expect(work.reclaimIdle(new Set())).toEqual([
      { sessionId: A, cwd, idleMs: expect.any(Number) },
    ])
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
  it('keeps a Session that is resident, however old its directory looks', () => {
    const { work } = newRoot()
    const cwd = sessionUsed(work, A, 30 * DAY)

    expect(work.reclaimIdle(new Set([A]))).toEqual([])
    expect(existsSync(cwd)).toBe(true)
  })

  /**
   * The rule this module exists to hold.
   *
   * Every record roma keeps about a Conversation sits beside these directories
   * as a file — a generation, a Chosen Model, a Chosen Effort, and the
   * `.pending` a half-written record leaves behind. A sweep that took them would
   * drop a Session's Chosen Model on the floor while the Session was still being
   * talked to, and put a Conversation back on the Pinned Model with nobody told.
   *
   * It used to be one line in the Session Pool and three comments in
   * `session-generation.ts`, in modules that do not import each other. This is
   * the assertion that holds it now.
   */
  it('steps over every file, however old', () => {
    const { root, work } = newRoot()
    const records = [`${A}.generation`, `${A}.model`, `${A}.effort`, `${A}.model.pending`]
    for (const name of records) {
      const path = join(root, name)
      writeFileSync(path, '1')
      age(path, 400 * DAY)
    }

    expect(work.reclaimIdle(new Set())).toEqual([])
    expect(readdirSync(root).sort()).toEqual([...records].sort())
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
  })

  // The rule the sweep enforces, read from the other end: a record is a sibling
  // of the directory it describes and never a child of it, so deleting the
  // directory cannot take it.
  it('puts no record inside the Session directory it describes', () => {
    const { work } = newRoot()

    for (const path of [work.generationRecord(A), work.modelRecord(A), work.effortRecord(A)]) {
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
  it('throws where a record exists and cannot be read', () => {
    const { work } = newRoot()
    mkdirSync(work.modelRecord(A), { recursive: true })

    expect(() => work.readRecord(work.modelRecord(A))).toThrow()
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
  it('refuses to remove a directory standing where a record should be', () => {
    const { work } = newRoot()
    mkdirSync(work.modelRecord(A), { recursive: true })

    expect(() => work.forgetRecord(work.modelRecord(A))).toThrow()
  })
})
