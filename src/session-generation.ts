import { CAVEMAN_MENU } from './caveman.js'
import { EFFORT_MENU } from './effort-menu.js'
import { MENU } from './model-menu.js'
import { sessionIdFor } from './session-id.js'
import type { WorkRoot } from './work-root.js'

/**
 * The four things roma remembers about a Conversation, in one place.
 *
 * Which Session it is on, since ADR-0014 which model that Session runs on, since
 * ADR-0016 what effort it runs at, and since ADR-0030 how short it is asked to
 * be. They are here together because they are the same trick and share the same
 * three rules: a record in the Work Root, a file rather than a directory, and a
 * missing one meaning "almost every Conversation" rather than "something is
 * wrong". Everything else roma knows is derived or is Claude Code's.
 *
 * The first two of those rules are the Work Root's and are argued there — where
 * the record is named, and why the sweep that walks that tree steps over it.
 * What is left here is the third, which is the only one that differs between the
 * four: a missing generation is zero, and a missing model, effort or Caveman is
 * the pinned one.
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

/**
 * Every Caveman a record may name: the Caveman Menu's own, and nothing else.
 *
 * `OFFERED_EFFORTS`' reasoning, and it holds the same way round twice over:
 * `wenyan-lite` and `wenyan-ultra` reach roma through `ROMA_CAVEMAN` alone, so a
 * record naming either is one nothing in roma wrote.
 *
 * **Never drop `off` from here on the grounds that it means "no record".** It is
 * a level a Caller may choose and so a value a record may name; `default` is the
 * one that is written down as nothing at all. Dropped, a Caller who asked to be
 * left alone on a deployment that pinned a Caveman would have every message they
 * sent afterwards refused.
 */
const OFFERED_CAVEMEN = new Set(CAVEMAN_MENU)

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

/**
 * A Session's Chosen Effort record names a level roma does not offer.
 *
 * `ChosenModelNotOffered`'s twin, and a class of its own rather than one error
 * carrying a kind: the Core routes on `instanceof` to two different sentences,
 * because `/model default` and `/effort default` are two different ways out.
 *
 * A narrower hole than the model's — the Effort Menu holds every level the build
 * has, so the only way to arrive here is roma *removing* one.
 */
export class ChosenEffortNotOffered extends Error {
  constructor(readonly effort: string) {
    super(`the Chosen Effort for this Session is not one roma offers: ${effort}`)
    this.name = 'ChosenEffortNotOffered'
  }
}

/**
 * A Session's Chosen Caveman record names a level roma does not offer.
 *
 * The third of these, and a class of its own for the reason the second is: the
 * Core routes on `instanceof` to a sentence per kind, because `/caveman default`
 * is a third way out and names a third Command.
 *
 * The widest hole of the three. The other two are reachable only by roma
 * *removing* something it offered; this one is reachable that way and by an
 * operator's own hand — `ROMA_CAVEMAN=wenyan-lite` is a value roma accepts and
 * this Set does not, so a record that named it would have to have been written
 * by something other than a Command.
 */
export class ChosenCavemanNotOffered extends Error {
  constructor(readonly caveman: string) {
    super(`the Chosen Caveman for this Session is not one roma offers: ${caveman}`)
    this.name = 'ChosenCavemanNotOffered'
  }
}

/** The three things a Session can be moved onto, one Chosen Record each. */
export type ChosenKind = 'model' | 'effort' | 'caveman'

export interface ChosenRecordOptions<K extends ChosenKind> {
  readonly kind: K
  /** The same Work Root the generations are kept in, for the same reasons. */
  readonly workRoot: WorkRoot
  /** Where this kind of record is filed, which is the Work Root's to decide. */
  readonly recordFor: (sessionId: string) => string
  /**
   * Every value a record may name.
   *
   * Gates the *record* and never `pinned`: an operator may pin something off the
   * Menu — `ROMA_EFFORT=ultracode` is the live case — and that must go on running
   * while a record naming it is still refused.
   */
  readonly offered: ReadonlySet<string>
  /**
   * What a Session runs on, or at, when nobody has said otherwise.
   *
   * Held here rather than looked up by each caller, so that "what is this Session
   * on" has one answer and `default` returns to what the deployment actually
   * pinned rather than to a name written down somewhere else.
   */
  readonly pinned: string
  /** How this kind refuses a record naming something off the Menu. */
  readonly notOffered: (written: string) => Error
}

/**
 * What one Session was moved onto, kept by roma rather than by the process.
 *
 * Written once and paid back three times — `chosenModels`, `chosenEfforts` and
 * `chosenCavemen` below are the three adapters, and this knows about none of
 * them. That is the whole of what makes it a seam: nothing here imports a Menu or
 * an error class.
 *
 * roma's rather than the process's, and that is the decision ADR-0014, ADR-0016
 * and ADR-0030 all make. A choice handed to a process lives and dies with it —
 * `--model`, `--effort` and `--append-system-prompt` are fixed at spawn, and
 * processes end at an Eviction, a Reaping or a deploy, which `CONTEXT.md` defines
 * as unobservable to the person using the Session. Kept there, a choice would be
 * a setting that reverts at a moment nobody can see.
 *
 * **Keyed by the Session id, never by the Conversation Key.** The Session id
 * derives from the Conversation Key and the Session Generation, and the reset
 * Command moves the generation — so a cleared Conversation asks about a Session
 * id with no record and is back on the pinned value, without anything being
 * deleted. Reverting is arithmetic rather than an action somebody has to
 * remember, and forgetting that action is the failure this exists to prevent:
 * the context cleared and the model still Opus.
 *
 * The price is litter. Every reset leaves a record under a Session id nothing
 * will use again, and records are never reclaimed — which is what keeps
 * generations safe — so this accumulates at tens of bytes per reset forever.
 *
 * Never in the Working Directory: the agent clones into it and runs `git add -A`
 * there (ADR-0008), and it is reclaimed after seven idle days.
 */
export class ChosenRecord<K extends ChosenKind> {
  /**
   * Which of the three this is.
   *
   * **Never remove this, and never replace it with an empty named subclass.** `K`
   * has to appear on a member of the class: without it `ChosenRecord<'model'>`,
   * `ChosenRecord<'effort'>` and `ChosenRecord<'caveman'>` are structurally
   * identical, and `CoreOptions` holds them in adjacent fields — swapping any two
   * compiles clean, and a Conversation is then told the effort it runs at as the
   * model it runs on. Measured both ways: with this field the swap is a TS2322,
   * and empty named subclasses do *not* fix it, because they share this class's
   * `#private` and add nothing structural.
   */
  readonly kind: K

  readonly #workRoot: WorkRoot
  readonly #recordFor: (sessionId: string) => string
  readonly #offered: ReadonlySet<string>
  readonly #pinned: string
  readonly #notOffered: (written: string) => Error

  constructor({ kind, workRoot, recordFor, offered, pinned, notOffered }: ChosenRecordOptions<K>) {
    this.kind = kind
    this.#workRoot = workRoot
    this.#recordFor = recordFor
    this.#offered = offered
    this.#pinned = pinned
    this.#notOffered = notOffered
  }

  /** What a Session runs on when nobody has chosen anything. */
  get pinned(): string {
    return this.#pinned
  }

  /**
   * What this Session actually runs on: what somebody chose, or the pinned value.
   *
   * The pinned value for almost every Session, and that is not written down — a
   * Session nobody moved has left no record, so the answer stands on its own for
   * everybody who never asked for anything else.
   *
   * Anything else on disk is an error rather than a reason to fall back: falling
   * back means running on something nobody chose and billing the Shared Window
   * for it, with the only evidence being answers that read as if they came from
   * somewhere else.
   */
  inForce(sessionId: string): string {
    return this.chosenFor(sessionId) ?? this.#pinned
  }

  /**
   * What this Session was moved onto, or null where nobody moved it.
   *
   * The distinction `inForce` collapses, kept because saying what a Session is on
   * needs it and running a Turn does not. A Session with no record *follows* the
   * pinned value; one whose record names that same value follows nothing. They
   * are one string today and two the moment an operator moves `ROMA_MODEL` or
   * `ROMA_EFFORT`, and a report calling both "default" would tell somebody who
   * typed `/model sonnet` that they are on whatever the deployment picks next.
   */
  chosenFor(sessionId: string): string | null {
    // Null is "there is no record", which is almost every Session, and only
    // that: `readRecord` throws for every other way a read can fail. So the
    // pinned value `inForce` falls back to can never be a choice that existed
    // and could not be read.
    const written = this.#workRoot.readRecord(this.#recordFor(sessionId))
    if (written === null) return null
    if (!this.#offered.has(written)) throw this.#notOffered(written)
    return written
  }

  /**
   * Move this Session onto one of the Menu's values.
   *
   * Nothing is torn down and nothing is checked against a running process: this
   * is aimed at what the *next* message reaches, and the Session Pool is what
   * maintains the invariant that a Turn runs on what its Session is on. Nothing
   * is checked against the Session's other record either — the Effort Matrix
   * reports and never refuses, so a `max` on a model that takes none is written
   * down and answered with a sentence rather than turned away.
   */
  choose(sessionId: string, value: string): void {
    this.#workRoot.writeRecord(this.#recordFor(sessionId), value)
  }

  /**
   * Put this Session back on the pinned value.
   *
   * Forgetting the record, never writing the pinned value into it: a Session that
   * asked for "default" must follow a deployment that moves `ROMA_MODEL` or
   * `ROMA_EFFORT`, and one carrying a literal would be stranded on what roma used
   * to run.
   *
   * The same state a fresh Session is in, which is the point — `default` and the
   * reset Command leave a Conversation in exactly one place.
   */
  usePinned(sessionId: string): void {
    this.#workRoot.forgetRecord(this.#recordFor(sessionId))
  }
}

export interface ChosenModelsOptions {
  readonly workRoot: WorkRoot
  /** Whatever `ROMA_MODEL` resolved to for this deployment. */
  readonly pinnedModel: string
}

/**
 * The Chosen Model record: which model each Session runs on.
 *
 * One of the three adapters over `ChosenRecord`. What it supplies is the whole of
 * what makes a model's record a model's: the Model Menu, the file the Work Root
 * files a model under, and the error a record off the Menu raises.
 */
export function chosenModels({
  workRoot,
  pinnedModel,
}: ChosenModelsOptions): ChosenRecord<'model'> {
  return new ChosenRecord({
    kind: 'model',
    workRoot,
    recordFor: (sessionId) => workRoot.modelRecord(sessionId),
    offered: OFFERED,
    pinned: pinnedModel,
    notOffered: (written) => new ChosenModelNotOffered(written),
  })
}

export interface ChosenEffortsOptions {
  readonly workRoot: WorkRoot
  /**
   * Whatever `ROMA_EFFORT` resolved to for this deployment. May be `ultracode`,
   * which is off the Menu — the same shape a Pinned Model off the Model Menu has,
   * and handled the same way: `offered` gates the record and never this.
   */
  readonly pinnedEffort: string
}

/**
 * The Chosen Effort record: what effort each Session runs at.
 *
 * `chosenModels`' twin, and sharper in one way that shows nowhere here: `--model`
 * is echoed back in `system/init` and the startup self-check asserts on it, where
 * `--effort` is echoed nowhere at all. What roma wrote down is the only account
 * there is of what a Session was asked to run at.
 */
export function chosenEfforts({
  workRoot,
  pinnedEffort,
}: ChosenEffortsOptions): ChosenRecord<'effort'> {
  return new ChosenRecord({
    kind: 'effort',
    workRoot,
    recordFor: (sessionId) => workRoot.effortRecord(sessionId),
    offered: OFFERED_EFFORTS,
    pinned: pinnedEffort,
    notOffered: (written) => new ChosenEffortNotOffered(written),
  })
}

export interface ChosenCavemenOptions {
  readonly workRoot: WorkRoot
  /**
   * Whatever `ROMA_CAVEMAN` resolved to for this deployment, which is `off` where
   * it named nothing. May be `wenyan-lite` or `wenyan-ultra`, which are off the
   * Caveman Menu — the shape a Pinned Effort of `ultracode` already has, and
   * handled the same way: `offered` gates the record and never this.
   */
  readonly pinnedCaveman: string
}

/**
 * The Chosen Caveman record: how short each Session is asked to be.
 *
 * The third adapter, and the one whose value never reaches a flag of its own.
 * `--model` and `--effort` are arguments naming what roma wrote down; a Caveman
 * is rendered into `--append-system-prompt` as English, so what is written here
 * is not merely the only account of what a Session was asked for — it is the only
 * place the answer exists as a *word* rather than as several thousand characters
 * of somebody else's prose.
 */
export function chosenCavemen({
  workRoot,
  pinnedCaveman,
}: ChosenCavemenOptions): ChosenRecord<'caveman'> {
  return new ChosenRecord({
    kind: 'caveman',
    workRoot,
    recordFor: (sessionId) => workRoot.cavemanRecord(sessionId),
    offered: OFFERED_CAVEMEN,
    pinned: pinnedCaveman,
    notOffered: (written) => new ChosenCavemanNotOffered(written),
  })
}
