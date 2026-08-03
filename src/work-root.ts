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

/** ADR-0003: one working directory per Session, reclaimed after seven days idle. */
const WORK_DIR_TTL_MS = 7 * 24 * 60 * 60_000

/**
 * What a record of a Conversation's generation is called, next to the working
 * directories of the Sessions it names.
 *
 * A file rather than a directory, deliberately: `reclaimIdle` walks this root
 * deleting directories nothing has used for seven days and steps over everything
 * else. A directory here would eventually be reclaimed, and reclaiming this is
 * not the same as reclaiming a working directory — it would send the
 * Conversation back to a Session it was moved off, with the context `/clear` was
 * used to drop.
 */
const GENERATION_SUFFIX = '.generation'

/**
 * What a record of a Session's Chosen Model is called, beside the generations.
 *
 * A file for the same reason, and the stakes are the same shape: reclaimed, a
 * Conversation that went quiet for seven days would come back on the Pinned
 * Model having asked for something else, at a moment nobody can observe.
 */
const MODEL_SUFFIX = '.model'

/**
 * What a record of a Session's Chosen Effort is called, beside the models.
 *
 * A file for the same reason and at the same stakes: reclaimed, a Conversation
 * that went quiet for seven days would come back at the Pinned Effort having
 * asked for something else, at a moment nobody can observe — and unlike the
 * model, nothing in the stream would say so afterwards, because `system/init`
 * carries no effort field at all (ADR-0016).
 */
const EFFORT_SUFFIX = '.effort'

/**
 * "There is no record", told apart from every other way a read can fail.
 *
 * Its own function for one caller, and a name rather than a saving: it was three
 * callers before the read moved here. The name is the point — `catch { return
 * null }` is the bug it is spelled out to prevent, and `readRecord` is where
 * what that bug would cost is argued.
 */
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * One working directory this sweep deleted, and what it knew about it.
 *
 * Returned rather than logged. The Work Root holds no Operator Log: what is
 * worth announcing is the Session Pool's judgement, and a module that both
 * decided and announced would be two reasons to change it.
 *
 * `idleMs` is here because it cannot be recovered — the directory it was
 * measured from is gone by the time anybody could ask. `cwd` is here for a
 * weaker reason and it is worth being honest about which: the caller could
 * derive it from `sessionDir`, and it comes back only so that building the
 * pool's `reclaim` record does not repeat a join this sweep has already done.
 */
export interface Reclaimed {
  readonly sessionId: string
  readonly cwd: string
  readonly idleMs: number
}

/**
 * The tree every Working Directory sits in, and every record beside them.
 *
 * Two kinds of entry live here and the difference is load-bearing: **a directory
 * is a Session's Working Directory, and a file is a record**. The sweep deletes
 * the first and steps over the second, which is the whole of why a Conversation
 * can go quiet for a fortnight and still come back on the model somebody chose.
 *
 * That rule used to be one line in the Session Pool (`if (!entry.isDirectory())
 * continue`) and three comments in `session-generation.ts` arguing that a record
 * had better be a file. The two modules did not import each other and the rule
 * was in neither type, so what held it was two tests in two files. It is here
 * now because a rule with four dependants deserves an owner, and because the
 * four kinds of file that rely on it — a generation, a Chosen Model, a Chosen
 * Effort, and the `.pending` a half-written record leaves behind — were each
 * added by somebody who had to rediscover it.
 *
 * **Not a Working Directory.** That word is one Session's own directory, which
 * ADR-0008 gives to the agent and into which roma puts exactly two things. This
 * is the tree they all sit in, and its layout is roma's alone.
 *
 * Holds nothing between calls. Two of these over one path are the same object in
 * every way that matters, which is what lets the composition root hand one to
 * every collaborator under it without any of them agreeing to share state.
 */
export class WorkRoot {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  /**
   * Where a Session's Working Directory is, whether or not it exists.
   *
   * A pure derivation: it makes no directory and asks the filesystem nothing, so
   * a Session that has never run has an answer too. That is the case that
   * matters — the first message to a Conversation is as likely to carry an
   * Enclosure as any other, and the Enclosure has to be written before the Turn
   * that reads it (ADR-0011).
   *
   * Deliberately not a promise that the directory is there. Creating one is a
   * spawn's business, and #105 is what happens when the two are confused: for as
   * long as the directory's existence was the record that a Session existed,
   * writing an Enclosure into it made roma resume a Session it had never run.
   */
  sessionDir(sessionId: string): string {
    return join(this.#root, sessionId)
  }

  /**
   * Mark a Session's Working Directory as used, now.
   *
   * The mtime **is** how long a Session has been idle — there is no second clock
   * and deliberately so. The sweep reads exactly what this writes, so a test
   * moves a directory's age by moving its mtime rather than by moving a clock
   * this module was handed. A `now` parameter would be a second source of time
   * that had to agree with the filesystem's, and nothing would notice when it
   * stopped.
   *
   * Takes the Session rather than the path its caller is holding, because a
   * `cwd` came from `sessionDir` here in the first place and handing it back
   * only invites a caller to pass one that did not. Not a rule the whole class
   * keeps: the record members below take a path, because a record is read and
   * written by name and the name is the useful thing to hand around. The two
   * currencies follow the two jobs — a sweep speaks Sessions, a record speaks
   * paths.
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
   * Delete every Working Directory nothing has used for seven days.
   *
   * `inUse` is the Session ids that must survive whatever their mtime says —
   * a resident process holds its directory open and a Turn in flight is
   * writing into it. Asked for rather than known: this module has no idea what a
   * process is, and the pool that does is the only caller.
   *
   * Required rather than optional, so that forgetting it is a type error instead
   * of an empty set — an empty set here deletes the directory out from under
   * every running Turn.
   *
   * Files are stepped over, and that is the rule this module exists to hold:
   * every record roma keeps about a Conversation sits beside these directories
   * as a file, and a sweep that took them would drop a Session's Chosen Model on
   * the floor while the Session itself was still being talked to.
   *
   * What is deliberately left behind is the Transcript, and what that costs is
   * argued where it is recovered rather than restated here — see
   * `SessionPool.reclaimIdleWorkDirs`, which is also where ADR-0006 is cited.
   * Two copies of that paragraph is one copy too many: the first thing to happen
   * to the second was that it lost a measured fact.
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
   * Where a Conversation's generation is written.
   *
   * Takes the Session id rather than the Conversation Key, and the caller is
   * what decides *which* id — generation zero's, so that the record is findable
   * knowing only the key. That rule belongs to whoever counts generations. What
   * belongs here is the one this module can state on its own: a Conversation Key
   * carries whatever a Channel puts in it, so nothing derived from one reaches a
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

  /**
   * What a record says, or null where there is none.
   *
   * Bytes and nothing else: what a record *means* — a generation is a count, a
   * model is on the Menu — is the caller's, and the Model Menu is a security
   * property that does not belong in a module about paths.
   *
   * Null means the file is not there, which is the ordinary answer: almost every
   * Conversation has never used `/clear` and almost every Session runs on the
   * Pinned Model. Every other failure throws, because a record that may exist and
   * cannot be read is not the same as one nobody wrote, and answering "none" to
   * both is how a Chosen Model disappears without anybody being told.
   *
   * Trimmed here so that three callers do not each remember to.
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
   * Write one record so that nothing can ever read half of it.
   *
   * Every reader of a record refuses one it cannot make sense of rather than
   * guessing at it — a generation that is not a count, a model that is not on
   * the Menu — and all of them are right to. None of those readers is here;
   * they are the three classes in `session-generation.ts`, and this is the write
   * that keeps them from ever having to defend against a torn line. That is not
   * the same as the state being unreachable: a `writeFileSync` onto the live name leaves a third
   * thing a reader can observe besides the old contents and the new, and a
   * machine that loses power mid-write is what produces it. What the
   * Conversation gets is a thread that stops working for a write nobody got
   * wrong.
   *
   * A rename within one directory is atomic, so a reader sees the old record or
   * the new one and never a part of either. The temporary name is in that same
   * directory for exactly that reason: across filesystems a rename is a copy,
   * and a copy is the thing being avoided.
   *
   * What it can leave behind is a `.pending` file, where the power went between
   * the write and the rename. It is bounded — one per record, overwritten by the
   * next attempt — and it is not a record: nothing reads that name, and
   * `reclaimIdle` steps over files as it does over the records themselves.
   * Litter of the same kind ADR-0014 already accepts, in exchange for a state no
   * reader has to be defended against.
   *
   * The root is made here rather than by each caller. A deployment's mount is
   * empty on its first boot, and three classes each remembering to create it was
   * three places for one of them to forget.
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
   * and that is the state being asked for. Deliberately **not** `recursive`: a
   * directory where a record should be is something roma did not put there and
   * cannot read, so this throws rather than quietly removing it — and the
   * Command answers that it failed instead of saying it moved a Session it did
   * not.
   */
  forgetRecord(path: string): void {
    rmSync(path, { force: true })
  }
}
