import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sessionIdFor } from './session-id.js'

/**
 * What a record of a Conversation's generation is called, next to the working
 * directories of the Sessions it names.
 *
 * A file rather than a directory, deliberately: `reclaimIdleWorkDirs` walks
 * `workRoot` deleting directories nothing has used for seven days and steps over
 * everything else. A directory here would eventually be reclaimed, and reclaiming
 * this is not the same as reclaiming a working directory — it would send the
 * Conversation back to a Session it was moved off, with the context `/new` was
 * used to drop.
 */
const SUFFIX = '.generation'

/** A generation as it is written down: a whole count and nothing else. */
const COUNT = /^\d+$/

/**
 * Whether a read failed because there is nothing there, rather than because
 * something is there and could not be read.
 *
 * The distinction is the whole of the fallback rule: no record means a
 * Conversation that has never used `/new`, which is almost all of them. Every
 * other failure describes a record that may exist.
 */
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export interface SessionGenerationsOptions {
  /**
   * The directory the Session Pool gives Sessions their working directories in.
   *
   * The same one, so that everything a Conversation has on disk is in one place
   * and a deployment has one path to mount.
   */
  readonly workRoot: string
}

/**
 * Which of a Conversation's Sessions is the current one, and how it gets a new
 * one.
 *
 * A Conversation Key cannot move: it is the Channel's, and the same DM carries
 * the same key forever. So `/new` cannot work by finding a different key, and
 * the Session id is a pure derivation from the key — which leaves exactly one
 * thing that can change, the generation, and one question: where it is kept.
 *
 * It is kept on disk, next to the working directories, because the alternative
 * is worse in a way nobody would see. Held in memory, a `/new` survives until
 * the next deploy and is then silently undone: the Conversation resumes the
 * transcript it asked to be rid of, and the only evidence is Claude Code
 * remembering things that were supposed to be gone. One small file per
 * Conversation buys the property `/new` is for.
 *
 * This is not the database roma does without. Nothing is looked *up* here: the
 * Session id is still derived from the Conversation Key, a Conversation that has
 * never used `/new` has no record at all, and losing every file in this directory
 * costs the Conversations that rotated their last rotation — not roma's ability
 * to find anybody's Session.
 */
export class SessionGenerations {
  readonly #workRoot: string

  constructor({ workRoot }: SessionGenerationsOptions) {
    this.#workRoot = workRoot
  }

  /** The Session this Conversation is on now. */
  sessionFor(conversationKey: string): string {
    return sessionIdFor(conversationKey, this.#generationOf(conversationKey))
  }

  /**
   * Move the Conversation onto a Session with nothing in it, and say which.
   *
   * The Session it was on is not touched. Its transcript stays where Claude Code
   * put it, its process — if it has one — is left to be reaped or evicted like
   * any other idle Session, and a Task already running in it still finishes and
   * still answers the person who asked. Only the *next* message goes somewhere
   * new, which is the whole of what `/new` promises.
   */
  freshSession(conversationKey: string): string {
    const generation = this.#generationOf(conversationKey) + 1
    // The Session id is derived first, so a Conversation Key this cannot name a
    // Session for is refused before anything is written down.
    const sessionId = sessionIdFor(conversationKey, generation)
    mkdirSync(this.#workRoot, { recursive: true })
    writeFileSync(this.#recordFor(conversationKey), String(generation), 'utf8')
    return sessionId
  }

  /**
   * How many times this Conversation has been given a fresh Session.
   *
   * Zero for almost every Conversation, and zero is not written down — a
   * Conversation that has never used `/new` is one that has left no record, so
   * the derivation stands on its own for everybody who never asked for anything
   * else.
   *
   * Anything else on disk is an error rather than a reason to fall back. Falling
   * back means generation zero, and generation zero is the context this
   * Conversation asked to be rid of.
   */
  #generationOf(conversationKey: string): number {
    let record: string
    try {
      record = readFileSync(this.#recordFor(conversationKey), 'utf8')
    } catch (error) {
      // Only "there is no record". Every other way a read fails — a permission,
      // an I/O error, a directory where the file should be — describes a record
      // that may well exist and cannot be read, and answering zero to those is
      // handing back the context `/new` was used to drop.
      if (isMissing(error)) return 0
      throw error
    }
    const written = record.trim()
    if (!COUNT.test(written)) {
      throw new Error(`Session generation for this Conversation is unreadable: ${written}`)
    }
    return Number(written)
  }

  /**
   * Where a Conversation's generation is written, named by the Session it
   * started on.
   *
   * The first generation's id rather than the current one, because this has to
   * be findable knowing only the Conversation Key — the current generation is
   * the thing being looked for. The Conversation Key itself is never written
   * anywhere: it can carry anything a Channel puts in it, and a file named after
   * one would leak a room name onto disk and break on the first key with a slash
   * in it.
   */
  #recordFor(conversationKey: string): string {
    return join(this.#workRoot, `${sessionIdFor(conversationKey)}${SUFFIX}`)
  }
}
