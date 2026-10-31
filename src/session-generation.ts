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

const COUNT = /^\d+$/

/** Enforced by `fence:session-record-names-only-the-menu`. */
const OFFERED = new Set(Object.values(MENU))

/** Enforced by `fence:session-record-names-only-the-menu`. */
const OFFERED_EFFORTS = new Set(EFFORT_MENU)

/** Enforced by `fence:session-caveman-off-is-a-level`. */
const OFFERED_CAVEMEN = new Set(CAVEMAN_MENU)

export interface SessionGenerationsOptions {
  /** The same Work Root the Session Pool gives Sessions their working directories in. */
  readonly workRoot: WorkRoot
}

/**
 * Which of a Conversation's Sessions is the current one, and how it gets a new
 * one. Kept on disk, next to the working directories.
 * Enforced by `fence:session-generation-kept-on-disk`.
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
   * Move the Conversation onto a Session with nothing in it, and say which. The
   * Session it was on is not touched: its Transcript stays, its process is left to
   * be reaped or evicted like any idle Session, and a Task already running in it
   * still finishes and answers. Only the *next* message goes somewhere new.
   */
  freshSession(conversationKey: string): string {
    const generation = this.#generationOf(conversationKey) + 1
    // The Session id is derived first, so a Conversation Key this cannot name a
    // Session for is refused before anything is written down.
    const sessionId = sessionIdFor(conversationKey, generation)
    this.#workRoot.writeRecord(this.#recordFor(conversationKey), String(generation))
    return sessionId
  }

  /** Enforced by `fence:session-generation-refuses-to-guess`. */
  #generationOf(conversationKey: string): number {
    const written = this.#workRoot.readRecord(this.#recordFor(conversationKey))
    if (written === null) return 0
    if (!COUNT.test(written)) {
      throw new Error(`Session generation for this Conversation is unreadable: ${written}`)
    }
    return Number(written)
  }

  /** Enforced by `fence:session-generation-filed-under-first-id`. */
  #recordFor(conversationKey: string): string {
    return this.#workRoot.generationRecord(sessionIdFor(conversationKey))
  }
}

/**
 * A Session's Chosen Model record names something roma does not offer: a failure
 * a Caller can clear, so the Core tells them how. `/model default` does not read
 * the record at all, so it is always a way out; clearing the Conversation is
 * another.
 */
export class ChosenModelNotOffered extends Error {
  constructor(readonly model: string) {
    super(`the Chosen Model for this Session is not one roma offers: ${model}`)
    this.name = 'ChosenModelNotOffered'
  }
}

/**
 * A Session's Chosen Effort record names a level roma does not offer. A class of
 * its own, because the Core routes on `instanceof` to the way out:
 * `/effort default`. Reachable only by roma removing a level from the Menu.
 */
export class ChosenEffortNotOffered extends Error {
  constructor(readonly effort: string) {
    super(`the Chosen Effort for this Session is not one roma offers: ${effort}`)
    this.name = 'ChosenEffortNotOffered'
  }
}

/**
 * A Session's Chosen Caveman record names a level roma does not offer. A class of
 * its own, because the Core routes on `instanceof` to the way out:
 * `/caveman default`. Reachable by roma removing a level, or by a record naming
 * a level only an operator may pin, which no Command writes.
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
   * Every value a record may name. Gates the *record* and never `pinned`.
   * Enforced by `fence:session-pinned-is-not-gated`.
   */
  readonly offered: ReadonlySet<string>
  /**
   * What a Session runs on, or at, when nobody has said otherwise: the one answer
   * to what `default` returns to.
   */
  readonly pinned: string
  /** How this kind refuses a record naming something off the Menu. */
  readonly notOffered: (written: string) => Error
}

/**
 * A Chosen Record. `chosenModels`, `chosenEfforts` and `chosenCavemen` are its
 * three adapters, and it knows none of them: nothing here imports a Menu or an
 * error class.
 *
 * Keyed by the Session id, in the Work Root, so the reset Command reverts it by
 * moving the generation. Enforced by `fence:session-choice-keyed-by-session-id`.
 */
export class ChosenRecord<K extends ChosenKind> {
  /**
   * Which of the three this is, and what keeps the three apart as types.
   * Enforced by `fence:session-chosen-kinds-do-not-swap`.
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
   * What this Session actually runs on: what somebody chose, or the pinned value
   * where there is no record. A record naming anything off the Menu throws rather
   * than falling back. Enforced by `fence:session-choice-refuses-to-guess`.
   */
  inForce(sessionId: string): string {
    return this.chosenFor(sessionId) ?? this.#pinned
  }

  /**
   * What this Session was moved onto, or null where nobody moved it: the
   * distinction `inForce` collapses. A Session with no record *follows* the pinned
   * value; one whose record names that same value follows nothing.
   * Enforced by `fence:session-chosen-pinned-is-still-chosen`.
   */
  chosenFor(sessionId: string): string | null {
    // Enforced by `fence:session-choice-refuses-to-guess`.
    const written = this.#workRoot.readRecord(this.#recordFor(sessionId))
    if (written === null) return null
    if (!this.#offered.has(written)) throw this.#notOffered(written)
    return written
  }

  /**
   * Move this Session onto one of the Menu's values, from the *next* message on.
   * Nothing is torn down, and nothing is checked against a running process (the
   * Session Pool keeps a Turn on what its Session is on) or against the Session's
   * other records.
   */
  choose(sessionId: string, value: string): void {
    this.#workRoot.writeRecord(this.#recordFor(sessionId), value)
  }

  /**
   * Put this Session back on the pinned value, by forgetting the record: the
   * state a fresh Session is in. Enforced by `fence:session-default-forgets`.
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

/** The Chosen Model record: which model each Session runs on. */
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
   * which is off the Menu: `offered` gates the record and never this.
   */
  readonly pinnedEffort: string
}

/** The Chosen Effort record: what effort each Session runs at. */
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
   * Caveman Menu: `offered` gates the record and never this.
   */
  readonly pinnedCaveman: string
}

/** The Chosen Caveman record: how short each Session is asked to be. */
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
