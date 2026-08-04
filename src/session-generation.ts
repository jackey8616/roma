import { EFFORT_MENU } from './effort-menu.js'
import { MENU } from './model-menu.js'
import { sessionIdFor } from './session-id.js'
import type { WorkRoot } from './work-root.js'

/**
 * The three things roma remembers about a Conversation, in one place.
 *
 * Which Session it is on, since ADR-0014 which model that Session runs on, and
 * since ADR-0016 what effort it runs at. They are here together because they are
 * the same trick and share the same three rules: a record in the Work Root, a
 * file rather than a directory, and a missing one meaning "almost every
 * Conversation" rather than "something is wrong". Everything else roma knows is
 * derived or is Claude Code's.
 *
 * The first two of those rules are the Work Root's and are argued there — where
 * the record is named, and why the sweep that walks that tree steps over it.
 * What is left here is the third, which is the only one that differs between the
 * three: a missing generation is zero, and a missing model or effort is the
 * pinned one.
 */

/** A generation as it is written down: a whole count and nothing else. */
const COUNT = /^\d+$/

/**
 * Every model a record may name: the Menu's own, and nothing else.
 *
 * A membership test, never a pattern: what it catches is a name roma has
 * *stopped* offering. Removing a Menu entry should be noticed, and a record
 * passed through to `--model` would let a Session go on running on something the
 * Menu no longer stands behind.
 */
const OFFERED = new Set(Object.values(MENU))

/**
 * Every effort a record may name: the Effort Menu's own, and nothing else.
 *
 * `OFFERED`'s reasoning exactly, and it holds the same way round: the only thing
 * that writes a record is an `/effort` whose argument was on the Menu, so
 * `ultracode` cannot get in here — a deployment that pinned it did so through
 * `ROMA_EFFORT`, which writes nothing and is not read here.
 */
const OFFERED_EFFORTS = new Set(EFFORT_MENU)

export interface SessionGenerationsOptions {
  /**
   * The Work Root the Session Pool gives Sessions their working directories in.
   *
   * The same one the pool has, so that everything a Conversation leaves on disk
   * is in one place and a deployment has one path to mount. The Work Root itself
   * rather than its path, because where a record goes and what a sweep may
   * delete are one fact and it is kept there.
   */
  readonly workRoot: WorkRoot
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
  readonly #workRoot: WorkRoot

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
    this.#workRoot.writeRecord(this.#recordFor(conversationKey), String(generation))
    return sessionId
  }

  /**
   * How many times this Conversation has been given a fresh Session.
   *
   * Zero is not written down: a Conversation that never used `/clear` leaves no
   * record.
   *
   * An unreadable record must throw, never fall back — falling back means
   * generation zero, which is the context this Conversation asked to be rid of.
   */
  #generationOf(conversationKey: string): number {
    const written = this.#workRoot.readRecord(this.#recordFor(conversationKey))
    // No record is generation zero, and only no record. Every other way a read
    // can fail — a permission, an I/O error, a directory where the file should
    // be — describes a record that may well exist and cannot be read, and
    // answering zero to those is handing back the context `/clear` was used to
    // drop. `readRecord` is what keeps those two apart: it answers null for the
    // first and throws for the rest.
    if (written === null) return 0
    if (!COUNT.test(written)) {
      throw new Error(`Session generation for this Conversation is unreadable: ${written}`)
    }
    return Number(written)
  }

  /**
   * Which Session's name a Conversation's generation record is filed under.
   *
   * The first generation's id, never the current one: the record has to be
   * findable knowing only the Conversation Key, and the current generation is
   * the thing being looked for. See `WorkRoot.generationRecord` for why nothing
   * derived from a Conversation Key may reach a filename.
   */
  #recordFor(conversationKey: string): string {
    return this.#workRoot.generationRecord(sessionIdFor(conversationKey))
  }
}

/**
 * A Session's Chosen Model record names something roma does not offer.
 *
 * Its own type because this is the one failure here a *Caller* can clear, and
 * they can only do it if somebody tells them how. Refusing to guess is right —
 * see `OFFERED` — but a refusal that surfaces as "roma could not run this Task"
 * on every message is loud in the log and silent in the thread, which is not
 * what story 38 asked for when it asked that removing a Menu entry be noticed.
 *
 * `/model default` is the way out and does not read the record at all, so the
 * sentence the Core builds from this can promise it. Clearing the Conversation
 * works too, by moving the Session id past the record entirely.
 */
export class ChosenModelNotOffered extends Error {
  constructor(readonly model: string) {
    super(`the Chosen Model for this Session is not one roma offers: ${model}`)
    this.name = 'ChosenModelNotOffered'
  }
}

export interface ChosenModelsOptions {
  /** The same Work Root the generations are kept in, for the same reasons. */
  readonly workRoot: WorkRoot
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
  readonly #workRoot: WorkRoot
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
    return this.chosenFor(sessionId) ?? this.#pinnedModel
  }

  /**
   * The model this Session was moved to, or null where nobody moved it.
   *
   * The distinction `modelFor` collapses, kept because saying which model a
   * Session is on needs it and running a Turn does not. A Session with no record
   * *follows* the Pinned Model; a Session whose record happens to name the same
   * model does not follow anything. They are one string today and two the moment
   * an operator moves `ROMA_MODEL`, and a report that called both of them
   * "default" would be telling somebody who typed `/model sonnet` that they are
   * on whatever the deployment picks next.
   */
  chosenFor(sessionId: string): string | null {
    // Null is "there is no record", which is almost every Session, and only
    // that: `readRecord` throws for every other way a read can fail. So the
    // Pinned Model `modelFor` falls back to can never be a Chosen Model that
    // existed and could not be read.
    const written = this.#workRoot.readRecord(this.#recordFor(sessionId))
    if (written === null) return null
    if (!OFFERED.has(written)) throw new ChosenModelNotOffered(written)
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
    this.#workRoot.writeRecord(this.#recordFor(sessionId), model)
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
    this.#workRoot.forgetRecord(this.#recordFor(sessionId))
  }

  /** Named after the Session itself; the Work Root is where that lands. */
  #recordFor(sessionId: string): string {
    return this.#workRoot.modelRecord(sessionId)
  }
}

/**
 * A Session's Chosen Effort record names a level roma does not offer.
 *
 * `ChosenModelNotOffered`'s twin, and it exists for the same one reason: this is
 * a failure a *Caller* can clear, and they can only do it if somebody tells them
 * how. `/effort default` is the way out and does not read the record at all, so
 * the sentence the Core builds from this can promise it.
 *
 * It is a narrower hole than the model's, because the Effort Menu holds every
 * level the build has — so the only way to arrive here is roma *removing* a
 * level, which is the case `OFFERED_EFFORTS` exists to make noticeable.
 */
export class ChosenEffortNotOffered extends Error {
  constructor(readonly effort: string) {
    super(`the Chosen Effort for this Session is not one roma offers: ${effort}`)
    this.name = 'ChosenEffortNotOffered'
  }
}

export interface ChosenEffortsOptions {
  /** The same Work Root the generations and the models are kept in. */
  readonly workRoot: WorkRoot
  /**
   * What a Session runs at when nobody has said otherwise — whatever
   * `ROMA_EFFORT` resolved to for this deployment.
   *
   * Held here rather than looked up by each caller, for `pinnedModel`'s reason:
   * "what effort is this Session at" has one answer, and `/effort default`
   * returns to what the deployment actually pinned rather than to a name written
   * down somewhere else. It may be `ultracode`, which is off the Menu — the same
   * shape a Pinned Model off the Model Menu has, and handled the same way.
   */
  readonly pinnedEffort: string
}

/**
 * What effort each Session runs at, and how somebody changes it.
 *
 * roma's rather than the process's, and that is the whole decision (ADR-0016).
 * Claude Code's own `/effort` says it in its own words — `Set effort level to max
 * (this session only)` — and a session is a process. Eviction, Reaping and a
 * deploy all end processes at moments `CONTEXT.md` defines as unobservable to
 * the person using the Session, so a choice kept there would not be effort
 * switching; it would be a setting that reverts at a time nobody can see.
 *
 * Sharper here than for the model, because there is no second opinion to fall
 * back on: `--model` is echoed in `system/init` and the startup self-check
 * asserts on it, and `--effort` is echoed nowhere at all. What roma wrote down is
 * the only account there is of what a Session was asked to run at.
 *
 * **Keyed by the Session id, not by the Conversation Key**, and every word of
 * `ChosenModels`' argument for that holds unchanged: the reset Command moves the
 * generation, so a cleared Conversation asks about a Session id that has no
 * record and is at the Pinned Effort, without anything being deleted. Reverting
 * is arithmetic rather than an action somebody has to remember. The price is the
 * same litter, at tens of bytes per reset forever, accepted for the same reason.
 */
export class ChosenEfforts {
  readonly #workRoot: WorkRoot
  readonly #pinnedEffort: string

  constructor({ workRoot, pinnedEffort }: ChosenEffortsOptions) {
    this.#workRoot = workRoot
    this.#pinnedEffort = pinnedEffort
  }

  /** What a Session runs at when nobody has chosen anything. */
  get pinnedEffort(): string {
    return this.#pinnedEffort
  }

  /**
   * The effort this Session runs at: its Chosen Effort, or the Pinned Effort.
   *
   * The Pinned Effort for almost every Session, and that is not written down.
   * Anything else on disk is an error rather than a reason to fall back, for
   * `modelFor`'s reason: falling back means running at an effort nobody chose and
   * billing the Shared Window for it, with no evidence anywhere that it happened.
   */
  effortFor(sessionId: string): string {
    return this.chosenFor(sessionId) ?? this.#pinnedEffort
  }

  /**
   * The effort this Session was moved to, or null where nobody moved it.
   *
   * The distinction `effortFor` collapses, kept for `ChosenModels.chosenFor`'s
   * reason: a Session with no record *follows* the Pinned Effort and a Session
   * whose record names the same level does not, and they are one string today and
   * two the moment an operator moves `ROMA_EFFORT`.
   */
  chosenFor(sessionId: string): string | null {
    const written = this.#workRoot.readRecord(this.#recordFor(sessionId))
    if (written === null) return null
    if (!OFFERED_EFFORTS.has(written)) throw new ChosenEffortNotOffered(written)
    return written
  }

  /**
   * Put this Session at one of the Menu's levels.
   *
   * Nothing is torn down and nothing is checked against a running process, and
   * nothing is checked against the Session's model either: the Effort Matrix
   * reports and never refuses, so a `max` on a model that takes none is written
   * down and answered with a sentence rather than turned away.
   */
  choose(sessionId: string, effort: string): void {
    this.#workRoot.writeRecord(this.#recordFor(sessionId), effort)
  }

  /**
   * Put this Session back at the Pinned Effort.
   *
   * Forgetting the record rather than writing the pinned level into it, for
   * `usePinnedModel`'s reason: a Session that asked for "default" must follow a
   * deployment that moves `ROMA_EFFORT`, and one carrying a literal would be
   * stranded at the effort roma used to run at.
   */
  usePinnedEffort(sessionId: string): void {
    this.#workRoot.forgetRecord(this.#recordFor(sessionId))
  }

  /** Named after the Session itself, beside its Chosen Model. */
  #recordFor(sessionId: string): string {
    return this.#workRoot.effortRecord(sessionId)
  }
}
