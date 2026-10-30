import type { CredentialKind } from './build-env.js'
import type { Turn } from './claude-session.js'
import { overflowOffer, spentUntil } from './shared-window.js'
import type { Compaction, SharedWindow } from './stream-events.js'

/**
 * How long a Task may be held waiting for the Shared Window before roma answers
 * it instead.
 *
 * Two, and not for the concurrency cap — a parked Task holds no slot. It is that
 * a third "still blocked" message lands on a Conversation that stopped watching
 * hours ago, and a Task that never ends is one nobody can be told anything
 * about.
 */
const MAX_PARKS = 2

/** Enforced by `fence:attempts-park-floor`. */
const MIN_PARK_MS = 60_000

/**
 * What one credential paid for, and what it bought.
 *
 * `costUsd` is the sum of the Attempts anything priced, and null only where
 * nothing priced any of them: a floor rather than a claim. `turnMs` is the most
 * recent Attempt that produced a Turn.
 */
export interface Spend {
  readonly costUsd: number | null
  readonly turnMs: number | null
  /**
   * What the Turns this credential paid for produced, or null where nothing
   * measured any of them: summed like `costUsd`, and split by credential the same
   * way, so that the two on one Audit Record describe the same Turns.
   */
  readonly outputTokens: number | null
  /**
   * The Compaction this credential paid for, or null where it paid for none.
   * Enforced by `fence:attempts-compaction-on-its-attempt`.
   *
   * The first one, where an Attempt produced two: the field says whether this
   * Task's cost includes a Compaction and who asked for it, not how many there
   * were.
   */
  readonly compaction: Compaction | null
}

const NOTHING_SPENT: Spend = {
  costUsd: null,
  turnMs: null,
  outputTokens: null,
  compaction: null,
}

/** Enforced by `fence:attempts-unpriced-is-not-free`. */
function withAttempt(
  soFar: number | null,
  reported: number | null | undefined,
  sent: boolean,
): number | null {
  if (reported == null) return soFar ?? (sent ? null : 0)
  return (soFar ?? 0) + reported
}

/** The terms of one wait on the Shared Window. */
export interface Park {
  /** When the provider says the window comes back, in seconds. */
  readonly resetsAt: number
  /**
   * Whether the provider would sell overage on this window: what the window
   * said, not whether roma has an Overflow credential to act on it.
   */
  readonly overageAllowed: boolean
}

/**
 * How long to wait for a window that comes back at `resetsAt`, from `now`. Call
 * it when the timer is armed, not when the park is booked: the Conversation is
 * told it is blocked in between, and however long that took would otherwise push
 * the wake-up out.
 *
 * Never sooner than a minute. Enforced by `fence:attempts-park-floor`.
 */
export function waitMsUntil(resetsAt: number, now: number): number {
  return Math.max(MIN_PARK_MS, resetsAt * 1000 - now)
}

interface Attempt {
  readonly credential: CredentialKind
  turn: Turn | null
  /** Whether Claude Code was ever given the Task's message on this try. */
  sent: boolean
  compaction: Compaction | null
}

/**
 * Every Attempt one Task has made, and what may be tried next. It replaced
 * eleven mutable fields on a record that seven methods wrote to.
 *
 * It decides nothing about time and performs no effect: it is asked whether a
 * park is owed and on what terms, and the Core owns the timer, the promise, and
 * telling the Conversation.
 */
export class Attempts {
  readonly #made: Attempt[] = []
  #credential: CredentialKind
  #window: SharedWindow | null = null
  #apiKeySource: string | null = null
  #parks = 0

  constructor(credential: CredentialKind) {
    this.#credential = credential
  }

  /**
   * Start an Attempt, and say which credential is paying for it. Starting one
   * clears the last one's reading of the Shared Window.
   * Enforced by `fence:attempts-reading-cleared-at-start`.
   */
  begins(): CredentialKind {
    this.#window = null
    this.#made.push({ credential: this.#credential, turn: null, sent: false, compaction: null })
    return this.#credential
  }

  /**
   * Claude Code was given the Task's message on the Attempt in flight: from here
   * the Attempt is no longer certainly free, even if its Turn reports nothing.
   */
  sent(): void {
    const attempt = this.#current
    if (attempt !== undefined) attempt.sent = true
  }

  /** What the stream said about the Shared Window during the Attempt in flight. */
  saw(window: SharedWindow): void {
    this.#window = window
  }

  /**
   * A Compaction happened inside the Attempt in flight. Kept, not acted on; the
   * first one stands.
   */
  compacted(compaction: Compaction): void {
    const attempt = this.#current
    if (attempt !== undefined) attempt.compaction ??= compaction
  }

  /**
   * The Compaction that happened inside this Task, whichever Attempt paid for
   * it, or null where none did. Blind to the credential, unlike `spentOn`: a
   * `/compact` that was blocked and reran on Overflow compacted once. The first
   * one stands.
   */
  compaction(): Compaction | null {
    return this.#made.find((attempt) => attempt.compaction !== null)?.compaction ?? null
  }

  /**
   * What Claude Code said its credential resolved to, off a Turn's `system/init`.
   * Null where the init carried nothing, which is not the reading `"none"`.
   */
  reported(apiKeySource: string | null): void {
    this.#apiKeySource = apiKeySource
  }

  /** End the Attempt in flight, with the Turn it produced or null for none. */
  ended(turn: Turn | null): void {
    const attempt = this.#current
    if (attempt !== undefined) attempt.turn = turn
  }

  /**
   * Pay for the next Attempt with this credential: the next one, not the one in
   * flight. Enforced by `fence:attempts-pay-for-the-next`.
   *
   * Overflow applies to one Attempt, so the caller moves it back afterwards.
   * Enforced by `fence:core-overflow-is-for-one-attempt`.
   */
  payWith(credential: CredentialKind): void {
    this.#credential = credential
  }

  /**
   * The credential the Attempt that ended this Task was paid for by, or null
   * before there has been one: the last Attempt, since the Core makes exactly one
   * before it answers or parks. Enforced by `fence:answered-by-the-last-attempt`.
   */
  answeredOn(): CredentialKind | null {
    return this.#made.at(-1)?.credential ?? null
  }

  /** Every credential that paid for part of this Task. */
  credentials(): CredentialKind[] {
    return [...new Set(this.#made.map((attempt) => attempt.credential))]
  }

  /**
   * What one credential paid for, apart from what any other paid for.
   * Enforced by `fence:attempts-bills-kept-apart`.
   *
   * Zero only where no message had gone by that point in the Task; a Turn that
   * began and reported nothing is null.
   * Enforced by `fence:attempts-unpriced-is-not-free`.
   */
  spentOn(credential: CredentialKind): Spend {
    // Enforced by `fence:attempts-unpriced-is-not-free`.
    let sent = false
    // The figures alone, because the Compaction is accumulated differently and
    // folding it in would put one in every literal below that neither reads nor
    // changes.
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

  /** What Claude Code last said its credential resolved to, or null if it never did. */
  apiKeySource(): string | null {
    return this.#apiKeySource
  }

  /**
   * Book a wait on the Shared Window, or null where none is owed: where the last
   * Attempt saw no spent window, where the event will not say when the window
   * comes back, and once a Task has waited `MAX_PARKS` times.
   * Enforced by `fence:attempts-park-is-bounded`.
   *
   * Says when the window comes back, not how long to wait, and touches no clock:
   * `waitMsUntil` is the other half, called when the timer is armed.
   */
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
