import type { CredentialKind } from './build-env.js'
import type { Turn } from './claude-session.js'
import { overflowOffer, spentUntil } from './shared-window.js'
import type { Compaction, SharedWindow } from './stream-events.js'

const MAX_PARKS = 2

const MIN_PARK_MS = 60_000

export interface Spend {
  readonly costUsd: number | null
  readonly turnMs: number | null
  readonly outputTokens: number | null
  readonly compaction: Compaction | null
}

const NOTHING_SPENT: Spend = {
  costUsd: null,
  turnMs: null,
  outputTokens: null,
  compaction: null,
}

function withAttempt(
  soFar: number | null,
  reported: number | null | undefined,
  sent: boolean,
): number | null {
  if (reported == null) return soFar ?? (sent ? null : 0)
  return (soFar ?? 0) + reported
}

export interface Park {
  readonly resetsAt: number
  readonly overageAllowed: boolean
}

export function waitMsUntil(resetsAt: number, now: number): number {
  return Math.max(MIN_PARK_MS, resetsAt * 1000 - now)
}

interface Attempt {
  readonly credential: CredentialKind
  turn: Turn | null
  sent: boolean
  compaction: Compaction | null
}

export class Attempts {
  readonly #made: Attempt[] = []
  #credential: CredentialKind
  #window: SharedWindow | null = null
  #apiKeySource: string | null = null
  #parks = 0

  constructor(credential: CredentialKind) {
    this.#credential = credential
  }

  begins(): CredentialKind {
    this.#window = null
    this.#made.push({ credential: this.#credential, turn: null, sent: false, compaction: null })
    return this.#credential
  }

  sent(): void {
    const attempt = this.#current
    if (attempt !== undefined) attempt.sent = true
  }

  saw(window: SharedWindow): void {
    this.#window = window
  }

  compacted(compaction: Compaction): void {
    const attempt = this.#current
    if (attempt !== undefined) attempt.compaction ??= compaction
  }

  compaction(): Compaction | null {
    return this.#made.find((attempt) => attempt.compaction !== null)?.compaction ?? null
  }

  reported(apiKeySource: string | null): void {
    this.#apiKeySource = apiKeySource
  }

  ended(turn: Turn | null): void {
    const attempt = this.#current
    if (attempt !== undefined) attempt.turn = turn
  }

  payWith(credential: CredentialKind): void {
    this.#credential = credential
  }

  answeredOn(): CredentialKind | null {
    return this.#made.at(-1)?.credential ?? null
  }

  credentials(): CredentialKind[] {
    return [...new Set(this.#made.map((attempt) => attempt.credential))]
  }

  spentOn(credential: CredentialKind): Spend {
    let sent = false
    let spend: Omit<Spend, 'compaction'> = NOTHING_SPENT
    let compaction: Compaction | null = null
    for (const attempt of this.#made) {
      sent ||= attempt.sent
      if (attempt.credential !== credential) continue
      compaction ??= attempt.compaction
      spend = {
        turnMs: attempt.turn?.durationMs ?? spend.turnMs,
        costUsd: withAttempt(spend.costUsd, attempt.turn?.costUsd, sent),
        outputTokens: withAttempt(spend.outputTokens, attempt.turn?.outputTokens, sent),
      }
    }
    return { ...spend, compaction }
  }

  apiKeySource(): string | null {
    return this.#apiKeySource
  }

  takePark(): Park | null {
    const window = this.#window
    if (window === null || this.#parks >= MAX_PARKS) return null
    const resetsAt = spentUntil(window)
    if (resetsAt === null) return null

    this.#parks += 1
    return { resetsAt, overageAllowed: overflowOffer(window) }
  }

  get #current(): Attempt | undefined {
    return this.#made.at(-1)
  }
}
