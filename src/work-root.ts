import { readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

/** ADR-0003: one working directory per Session, reclaimed after seven days idle. */
const WORK_DIR_TTL_MS = 7 * 24 * 60 * 60_000

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
 * The one directory a deployment has to mount, and everything roma remembers.
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
 * four collaborators without any of them agreeing to share state.
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
   * Takes the Session rather than the path, so that every member here speaks the
   * same word. A caller holding a `cwd` got it from `sessionDir` in the first
   * place, and one that could pass any path at all could age a directory this
   * module does not own.
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
}
