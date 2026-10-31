import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const WORK_DIR_TTL_MS = 7 * 24 * 60 * 60_000

/** Enforced by `fence:workroot-records-survive-the-sweep`. */
const GENERATION_SUFFIX = '.generation'

/** Enforced by `fence:workroot-records-survive-the-sweep`. */
const MODEL_SUFFIX = '.model'

/** Enforced by `fence:workroot-records-survive-the-sweep`. */
const EFFORT_SUFFIX = '.effort'

/** Enforced by `fence:workroot-records-survive-the-sweep`. */
const CAVEMAN_SUFFIX = '.caveman'

/** Enforced by `fence:workroot-records-survive-the-sweep`. */
const OPENED_SUFFIX = '.opened'

/** Enforced by `fence:workroot-unreadable-is-not-missing`. */
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * One working directory this sweep deleted, and what it knew about it. Returned
 * rather than logged: announcing it is the caller's. `idleMs` cannot be recovered
 * afterwards, since the directory it was measured from is gone; `cwd` could be
 * derived from `sessionDir`, and comes back only to save the caller the join.
 */
export interface Reclaimed {
  readonly sessionId: string
  readonly cwd: string
  readonly idleMs: number
}

/**
 * Holds nothing between calls: two of these over one path are the same object in
 * every way that matters, so one can be handed to every collaborator.
 */
export class WorkRoot {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  /**
   * Where a Session's Working Directory is, whether or not it exists. A pure
   * derivation: it makes no directory and asks the filesystem nothing, so a
   * Session that has never run has an answer too. Enforced by
   * `fence:workroot-session-dir-makes-nothing`.
   */
  sessionDir(sessionId: string): string {
    return join(this.#root, sessionId)
  }

  /**
   * Mark a Session's Working Directory as used, now. Its mtime **is** how long the
   * Session has been idle; there is no second clock, so a test ages a directory
   * by moving its mtime. Takes the Session rather than a path because a sweep
   * speaks Sessions, while the record members below speak paths.
   */
  touch(sessionId: string): void {
    const seconds = Date.now() / 1000
    try {
      utimesSync(this.sessionDir(sessionId), seconds, seconds)
    } catch {
      // A directory reclaimed underneath us is not worth failing a Turn over.
    }
  }

  /**
   * Delete every Working Directory nothing has used for seven days. `inUse` is the
   * Session ids that must survive whatever their mtime says: a resident process
   * holds its directory open and a Turn in flight is writing into it.
   *
   * Required. Enforced by `fence:workroot-in-use-is-required`.
   *
   * Files are stepped over. Enforced by `fence:workroot-records-survive-the-sweep`.
   */
  reclaimIdle(inUse: ReadonlySet<string>): readonly Reclaimed[] {
    let entries
    try {
      entries = readdirSync(this.#root, { withFileTypes: true })
    } catch {
      return []
    }

    const now = Date.now()
    const reclaimed: Reclaimed[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionId = entry.name
      if (inUse.has(sessionId)) continue

      const cwd = this.sessionDir(sessionId)
      let idleMs: number
      try {
        idleMs = now - statSync(cwd).mtimeMs
      } catch {
        continue
      }
      if (idleMs < WORK_DIR_TTL_MS) continue

      rmSync(cwd, { recursive: true, force: true })
      reclaimed.push({ sessionId, cwd, idleMs })
    }
    return reclaimed
  }

  /**
   * Where a Conversation's generation is written. Takes a Session id, and the
   * caller decides which: generation zero's, so the record is findable knowing
   * only the Conversation Key. Nothing derived from a Conversation Key reaches a
   * filename through this module.
   */
  generationRecord(sessionId: string): string {
    return join(this.#root, `${sessionId}${GENERATION_SUFFIX}`)
  }

  /** Where a Session's Chosen Model is written, beside its generation. */
  modelRecord(sessionId: string): string {
    return join(this.#root, `${sessionId}${MODEL_SUFFIX}`)
  }

  /** Where a Session's Chosen Effort is written, beside its model. */
  effortRecord(sessionId: string): string {
    return join(this.#root, `${sessionId}${EFFORT_SUFFIX}`)
  }

  /** Where a Session's Chosen Caveman is written, beside its effort. */
  cavemanRecord(sessionId: string): string {
    return join(this.#root, `${sessionId}${CAVEMAN_SUFFIX}`)
  }

  /** Where the record that a Session has been opened is written, beside its Caveman. */
  openedRecord(sessionId: string): string {
    return join(this.#root, `${sessionId}${OPENED_SUFFIX}`)
  }

  /**
   * What a record says, trimmed, or null where the file is not there. Bytes only:
   * what a record means is the caller's to check. Every other failure throws.
   * Enforced by `fence:workroot-unreadable-is-not-missing`.
   */
  readRecord(path: string): string | null {
    let contents: string
    try {
      contents = readFileSync(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    return contents.trim()
  }

  /**
   * Write one record so that nothing can ever read half of it: a temporary name
   * in the same directory, renamed over the record. Enforced by
   * `fence:workroot-record-write-is-atomic`. Creates the root if it is missing.
   *
   * A power cut between the write and the rename leaves a `.pending` file: one
   * per record, overwritten by the next attempt, read by nothing, and stepped
   * over by `reclaimIdle`.
   */
  writeRecord(path: string, contents: string): void {
    mkdirSync(this.#root, { recursive: true })
    const pending = `${path}.pending`
    writeFileSync(pending, contents, 'utf8')
    renameSync(pending, path)
  }

  /**
   * Forget a record, whether or not there was one.
   *
   * `force` for the Session nobody ever moved, where there is nothing to delete
   * and that is the state being asked for. Throws on a directory where a record
   * should be. Enforced by `fence:workroot-forget-is-not-recursive`.
   */
  forgetRecord(path: string): void {
    rmSync(path, { force: true })
  }
}
