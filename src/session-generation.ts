import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MENU } from './model-menu.js'
import { sessionIdFor } from './session-id.js'

/**
 * The two things roma remembers about a Conversation, in one place.
 *
 * Which Session it is on, and — since ADR-0014 — which model that Session runs
 * on. They are here together because they are the same trick and share the same
 * three rules: a record in the work root, a file rather than a directory, and a
 * missing one meaning "almost every Conversation" rather than "something is
 * wrong". Everything else roma knows is derived or is Claude Code's.
 */

/**
 * What a record of a Conversation's generation is called, next to the working
 * directories of the Sessions it names.
 *
 * A file rather than a directory, deliberately: `reclaimIdleWorkDirs` walks
 * `workRoot` deleting directories nothing has used for seven days and steps over
 * everything else. A directory here would eventually be reclaimed, and reclaiming
 * this is not the same as reclaiming a working directory — it would send the
 * Conversation back to a Session it was moved off, with the context `/clear` was
 * used to drop.
 */
const SUFFIX = '.generation'

/**
 * What a record of a Session's Chosen Model is called, beside the generations.
 *
 * A file for the same reason, and the stakes are the same shape: reclaimed, a
 * Conversation that went quiet for seven days would come back on the Pinned Model
 * having asked for something else, at a moment nobody can observe.
 */
const MODEL_SUFFIX = '.model'

/** A generation as it is written down: a whole count and nothing else. */
const COUNT = /^\d+$/

/**
 * Every model a record may name: the Menu's own, and nothing else.
 *
 * Read against rather than parsed with a pattern, so that one check covers two
 * failures a Session must not run through. A torn line — what a machine that lost
 * power mid-write leaves — is not a model roma offers. Neither is a name roma has
 * *stopped* offering, and that one is the reason this is a membership test:
 * removing a Menu entry should be a change somebody notices, and a record quietly
 * passed through to `--model` would let a Session go on running on something the
 * Menu no longer stands behind.
 *
 * Nothing else can get in here: the only thing that writes a record is a `/model`
 * whose argument was on the Menu.
 */
const OFFERED = new Set(Object.values(MENU))

/**
 * Whether a read failed because there is nothing there, rather than because
 * something is there and could not be read.
 *
 * The distinction is the whole of the fallback rule: no record means a
 * Conversation that has never used `/clear`, which is almost all of them. Every
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
 * the same key forever. So `/clear` cannot work by finding a different key, and
 * the Session id is a pure derivation from the key — which leaves exactly one
 * thing that can change, the generation, and one question: where it is kept.
 *
 * It is kept on disk, next to the working directories, because the alternative
 * is worse in a way nobody would see. Held in memory, a `/clear` survives until
 * the next deploy and is then silently undone: the Conversation resumes the
 * transcript it asked to be rid of, and the only evidence is Claude Code
 * remembering things that were supposed to be gone. One small file per
 * Conversation buys the property `/clear` is for.
 *
 * This is not the database roma does without. Nothing is looked *up* here: the
 * Session id is still derived from the Conversation Key, a Conversation that has
 * never used `/clear` has no record at all, and losing every file in this directory
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
   * new, which is the whole of what `/clear` promises.
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
   * Conversation that has never used `/clear` is one that has left no record, so
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
      // handing back the context `/clear` was used to drop.
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

export interface ChosenModelsOptions {
  /** The same directory the generations are kept in, for the same reasons. */
  readonly workRoot: string
  /**
   * What a Session runs on when nobody has said otherwise — whatever `ROMA_MODEL`
   * resolved to for this deployment.
   *
   * Held here rather than looked up by each caller, so that "which model is this
   * Session on" has one answer and `/model default` returns to what the
   * deployment actually pinned rather than to a name written down somewhere else.
   */
  readonly pinnedModel: string
}

/**
 * Which model each Session runs on, and how somebody changes it.
 *
 * roma's rather than the process's, and that is the whole decision (ADR-0014). A
 * model handed to a process lives and dies with it: `--model` is fixed at spawn,
 * and processes end for reasons — Eviction, Reaping, a deploy — that `CONTEXT.md`
 * defines as unobservable to the person using the Session. A choice kept there
 * would be a setting that reverts at a moment nobody can see.
 *
 * **Keyed by the Session id, not by the Conversation Key**, and the difference is
 * how reverting works. The Session id derives from the Conversation Key and the
 * Session Generation, and the reset Command moves the generation — so a cleared
 * Conversation asks about a Session id that has no record and is on the Pinned
 * Model, without anything being deleted. Reverting is arithmetic rather than an
 * action somebody has to remember to perform, and forgetting that action is
 * exactly the failure this feature exists to prevent: the context cleared and the
 * model still Opus.
 *
 * The price is litter. Every reset leaves a record under a Session id nothing
 * will use again, and records are never reclaimed — which is what keeps
 * generations safe — so this accumulates at tens of bytes per reset forever.
 * Accepted over a deletion that has to be remembered.
 *
 * Not in the Working Directory: the agent clones into it and runs `git add -A`
 * there (ADR-0008), and it is reclaimed after seven idle days. Either one is
 * disqualifying on its own.
 */
export class ChosenModels {
  readonly #workRoot: string
  readonly #pinnedModel: string

  constructor({ workRoot, pinnedModel }: ChosenModelsOptions) {
    this.#workRoot = workRoot
    this.#pinnedModel = pinnedModel
  }

  /** What a Session runs on when nobody has chosen anything. */
  get pinnedModel(): string {
    return this.#pinnedModel
  }

  /**
   * The model this Session runs on: its Chosen Model, or the Pinned Model.
   *
   * The Pinned Model for almost every Session, and that is not written down — a
   * Session nobody has moved is one that has left no record, so the answer stands
   * on its own for everybody who never asked for anything else.
   *
   * Anything else on disk is an error rather than a reason to fall back, for the
   * reason a generation's is: falling back means running on a model nobody chose
   * and billing the Shared Window for it, with the only evidence being answers
   * that read as if they came from somewhere else.
   */
  modelFor(sessionId: string): string {
    let record: string
    try {
      record = readFileSync(this.#recordFor(sessionId), 'utf8')
    } catch (error) {
      // Only "there is no record" — which is almost every Session. Every other
      // way a read fails describes a record that may well exist and cannot be
      // read, and answering the Pinned Model to those is a Chosen Model
      // disappearing silently.
      if (isMissing(error)) return this.#pinnedModel
      throw error
    }
    const written = record.trim()
    if (!OFFERED.has(written)) {
      throw new Error(`the Chosen Model for this Session is not one roma offers: ${written}`)
    }
    return written
  }

  /**
   * Put this Session on one of the Menu's models.
   *
   * Nothing is torn down and nothing is checked against a running process: this
   * is aimed at what the *next* message reaches, and the Session Pool is what
   * maintains the invariant that a Turn runs on the model its Session is on.
   */
  choose(sessionId: string, model: string): void {
    mkdirSync(this.#workRoot, { recursive: true })
    writeFileSync(this.#recordFor(sessionId), model, 'utf8')
  }

  /**
   * Put this Session back on the Pinned Model.
   *
   * Forgetting the record rather than writing the pinned name into it, and the
   * difference shows the day a deployment moves `ROMA_MODEL`: a Session that
   * asked for "default" must follow that move, and one carrying a literal would
   * be stranded on the model roma used to run.
   *
   * The same state a fresh Session is in, which is the point — `/model default`
   * and the reset Command leave a Conversation in exactly one place.
   */
  usePinnedModel(sessionId: string): void {
    // `force` for the Session nobody ever moved, where there is nothing to
    // delete and that is the state being asked for. Deliberately not
    // `recursive`: a directory where the record should be is something roma did
    // not put there and cannot read, so this throws rather than quietly removing
    // it — and the Command answers that it failed instead of saying it moved a
    // Session it did not.
    rmSync(this.#recordFor(sessionId), { force: true })
  }

  /**
   * Where a Session's Chosen Model is written, named after the Session itself.
   *
   * Beside the generation records, so everything roma remembers about a
   * Conversation is in one directory a deployment has to mount.
   */
  #recordFor(sessionId: string): string {
    return join(this.#workRoot, `${sessionId}${MODEL_SUFFIX}`)
  }
}
