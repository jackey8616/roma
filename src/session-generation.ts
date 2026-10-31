import { CAVEMAN_MENU } from './caveman.js'
import { EFFORT_MENU } from './effort-menu.js'
import { MENU } from './model-menu.js'
import { sessionIdFor } from './session-id.js'
import type { WorkRoot } from './work-root.js'

const COUNT = /^\d+$/

const OFFERED = new Set(Object.values(MENU))

const OFFERED_EFFORTS = new Set(EFFORT_MENU)

const OFFERED_CAVEMEN = new Set(CAVEMAN_MENU)

export interface SessionGenerationsOptions {
  readonly workRoot: WorkRoot
}

export class SessionGenerations {
  readonly #workRoot: WorkRoot

  constructor({ workRoot }: SessionGenerationsOptions) {
    this.#workRoot = workRoot
  }

  sessionFor(conversationKey: string): string {
    return sessionIdFor(conversationKey, this.#generationOf(conversationKey))
  }

  freshSession(conversationKey: string): string {
    const generation = this.#generationOf(conversationKey) + 1
    const sessionId = sessionIdFor(conversationKey, generation)
    this.#workRoot.writeRecord(this.#recordFor(conversationKey), String(generation))
    return sessionId
  }

  #generationOf(conversationKey: string): number {
    const written = this.#workRoot.readRecord(this.#recordFor(conversationKey))
    if (written === null) return 0
    if (!COUNT.test(written)) {
      throw new Error(`Session generation for this Conversation is unreadable: ${written}`)
    }
    return Number(written)
  }

  #recordFor(conversationKey: string): string {
    return this.#workRoot.generationRecord(sessionIdFor(conversationKey))
  }
}

export class ChosenModelNotOffered extends Error {
  constructor(readonly model: string) {
    super(`the Chosen Model for this Session is not one roma offers: ${model}`)
    this.name = 'ChosenModelNotOffered'
  }
}

export class ChosenEffortNotOffered extends Error {
  constructor(readonly effort: string) {
    super(`the Chosen Effort for this Session is not one roma offers: ${effort}`)
    this.name = 'ChosenEffortNotOffered'
  }
}

export class ChosenCavemanNotOffered extends Error {
  constructor(readonly caveman: string) {
    super(`the Chosen Caveman for this Session is not one roma offers: ${caveman}`)
    this.name = 'ChosenCavemanNotOffered'
  }
}

export type ChosenKind = 'model' | 'effort' | 'caveman'

export interface ChosenRecordOptions<K extends ChosenKind> {
  readonly kind: K
  readonly workRoot: WorkRoot
  readonly recordFor: (sessionId: string) => string
  readonly offered: ReadonlySet<string>
  readonly pinned: string
  readonly notOffered: (written: string) => Error
}

export class ChosenRecord<K extends ChosenKind> {
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

  get pinned(): string {
    return this.#pinned
  }

  inForce(sessionId: string): string {
    return this.chosenFor(sessionId) ?? this.#pinned
  }

  chosenFor(sessionId: string): string | null {
    const written = this.#workRoot.readRecord(this.#recordFor(sessionId))
    if (written === null) return null
    if (!this.#offered.has(written)) throw this.#notOffered(written)
    return written
  }

  choose(sessionId: string, value: string): void {
    this.#workRoot.writeRecord(this.#recordFor(sessionId), value)
  }

  usePinned(sessionId: string): void {
    this.#workRoot.forgetRecord(this.#recordFor(sessionId))
  }
}

export interface ChosenModelsOptions {
  readonly workRoot: WorkRoot
  readonly pinnedModel: string
}

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
  readonly pinnedEffort: string
}

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
  readonly pinnedCaveman: string
}

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
