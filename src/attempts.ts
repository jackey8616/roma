import type { CredentialKind } from './build-env.js'
import type { Turn } from './claude-session.js'
import { overflowOffer, spentUntil } from './shared-window.js'
import type { Compaction, SharedWindow } from './stream-events.js'

/**
 * How long a Task may be held waiting for the Shared Window before roma answers
 * it instead.
 *
 * Two, and the reason is neither the concurrency cap nor patience: a parked Task
 * holds no slot, so it cannot halt roma. It is that a third "still blocked"
 * message lands on a Conversation that stopped watching hours ago, and that a
 * Task which never ends is one nobody can be told anything about. Answered and
 * re-sendable beats held for ever.
 */
const MAX_PARKS = 2

/**
 * The shortest a park can be.
 *
 * A backstop against a reset time that has already passed — a provider reporting
 * a stale one, a clock that disagrees with theirs. Without it such a Task reruns
 * instantly, fails, parks again, and spins as fast as Claude Code can start,
 * announcing itself on every Attempt.
 */
const MIN_PARK_MS = 60_000

/**
 * What one credential paid for.
 *
 * `costUsd` is the sum of the Attempts anything priced, and null only where
 * nothing priced any of them — a floor rather than a claim, which is the same
 * promise the Audit Record makes about it. `turnMs` is the most recent Attempt
 * that produced a Turn, because it answers "how long was Claude Code working"
 * and an Attempt that produced none did none of that work.
 */
export interface Spend {
  readonly costUsd: number | null
  readonly turnMs: number | null
  /**
   * The Compaction this credential paid for, or null where it paid for none.
   *
   * Here rather than on the Task because a Compaction is a cost fact and this is
   * where a Task's costs are split: a Task blocked on the Shared Window and rerun
   * on Overflow produces two records, and the Compaction belongs on whichever of
   * them carries the money it spent. Filed anywhere else it would say a metered
   * bill included a Compaction the subscription paid for.
   *
   * The first one, where an Attempt somehow produced two. The field answers
   * whether this Task's cost includes a Compaction and who asked for it, not how
   * many there were — and `trigger` cannot differ between two of them within one
   * Task, since what a Task is decides it.
   */
  readonly compaction: Compaction | null
}

/** A Task that spent nothing yet, or spent nothing at all. */
const NOTHING_SPENT: Spend = { costUsd: null, turnMs: null, compaction: null }

/** The terms of one wait on the Shared Window. */
export interface Park {
  /** When the provider says the window comes back, in seconds. */
  readonly resetsAt: number
  /**
   * Whether the provider would sell overage on this window.
   *
   * What the window said, not whether roma can act on it: an Overflow credential
   * has to be configured too, and that is the Core's to know.
   */
  readonly overageAllowed: boolean
}

/**
 * How long to wait for a window that comes back at `resetsAt`, from `now`.
 *
 * Separate from booking the park, and called when the timer is armed rather than
 * when the wait is decided: the Conversation is told it is blocked in between,
 * and a Channel that took a while to accept that message would otherwise push
 * the Task's wake-up out by however long it took.
 *
 * Never sooner than a minute. A reset time already in the past — a provider
 * reporting a stale one, a clock that disagrees with theirs — would otherwise
 * rerun the Task instantly and, on failing again, park it again: a Task spinning
 * as fast as Claude Code can start, announcing itself on every Attempt.
 */
export function waitMsUntil(resetsAt: number, now: number): number {
  return Math.max(MIN_PARK_MS, resetsAt * 1000 - now)
}

/** One try at serving a Task, and what it turned into. */
interface Attempt {
  readonly credential: CredentialKind
  turn: Turn | null
  /** Whether Claude Code was ever given the Task's message on this try. */
  sent: boolean
  /** The Compaction that happened inside this try's Turn, if one did. */
  compaction: Compaction | null
}

/**
 * Every Attempt one Task has made, and what may be tried next.
 *
 * A Task is not one try at Claude Code. The Shared Window can block it, Overflow
 * can be taken on it, and the window can come back — so `CONTEXT.md`'s "one Task
 * drives one Turn" describes the path where nothing goes wrong, and up to three
 * Turns is the real bound. This is the layer that sits between the two, and it
 * exists because the alternative was eleven mutable fields on a record that
 * seven methods wrote to, with every rule between them stated in prose.
 *
 * It decides nothing about time and performs no effect: it is asked whether a
 * park is owed and on what terms, and the Core is what owns the timer, the
 * promise, and telling the Conversation. That is what makes `MIN_PARK_MS` a
 * number a test can read rather than an interval it has to sit through.
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
   * Start an Attempt, and say which credential is paying for it.
   *
   * Starting one is what clears the last one's reading of the Shared Window, and
   * that is not tidiness: a reading left behind has a `resetsAt` that has already
   * passed, so a later failure carrying no reading of its own — a process that
   * died, a Retry Storm — would park against a moment in the past and rerun
   * instantly, for ever, reporting each Attempt as the window being spent.
   *
   * One call rather than a field to read and a field to clear, so that the rule
   * cannot be half-applied.
   */
  begins(): CredentialKind {
    this.#window = null
    this.#made.push({ credential: this.#credential, turn: null, sent: false, compaction: null })
    return this.#credential
  }

  /**
   * Claude Code was given the Task's message on the Attempt in flight.
   *
   * Deliberately not named for the Turn beginning, though that is what prompts
   * it: what this records is that the message went, which is the moment the
   * Attempt stops being free with certainty. A Turn that begins and reports
   * nothing still spent whatever it spent.
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
   * A Compaction happened inside the Attempt in flight.
   *
   * Kept rather than acted on: a successful Compaction prompts no decision at
   * all — roma cannot prevent it, delay it, or react to it — so it is a fact
   * about what this Attempt cost and nothing else. The Operator Log is what roma
   * decided, and this is not that.
   *
   * The first one stands, for the reason `Spend.compaction` gives.
   */
  compacted(compaction: Compaction): void {
    const attempt = this.#current
    if (attempt !== undefined) attempt.compaction ??= compaction
  }

  /**
   * What Claude Code said its credential resolved to, off a Turn's `system/init`.
   *
   * Nullable because the event's own field is: `"none"` under the OAuth token is
   * a reading, but an init that carries nothing is not, and the Audit Record
   * says so rather than inventing one.
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
   * Pay for the next Attempt with this credential.
   *
   * The next one, not the one in flight: Overflow is taken on a Task that is
   * already parked, and it applies to one Attempt. Where it is not moved back
   * afterwards a Task that took it and failed would go on spending metered money
   * with nobody asked and no cap consulted.
   */
  payWith(credential: CredentialKind): void {
    this.#credential = credential
  }

  /**
   * The credential the Attempt that ended this Task was paid for by, or null
   * before there has been one.
   *
   * The last Attempt, because the Core makes exactly one before it answers or
   * parks — so the last one is always the Attempt the Task ended on: the answer
   * where there is one, and the last thing tried where there is not.
   *
   * Kept in the order the Attempts happened rather than grouped by credential,
   * which is the whole reason this is a list. Grouped, the only order left is
   * which credential *first* paid, and a Task blocked on the Shared Window,
   * rerun on Overflow, blocked again, and answered by the window coming back
   * names Overflow — the one credential of the two that produced nothing.
   */
  answeredOn(): CredentialKind | null {
    return this.#made.at(-1)?.credential ?? null
  }

  /** Every credential that paid for part of this Task. */
  credentials(): CredentialKind[] {
    return [...new Set(this.#made.map((attempt) => attempt.credential))]
  }

  /**
   * What one credential paid for.
   *
   * Kept apart from the others rather than summed, because the two are different
   * money and only one of them is capped. A Task blocked on the Shared Window and
   * rerun on Overflow made two Attempts on two bills; added together and filed
   * under the credential it ended on, the subscription's share would be charged
   * to the metered cap — which would refuse other people's work over money nobody
   * spent on a card, and would be shown to the person who asked as what their
   * Overflow decision cost them.
   *
   * Zero is a claim rather than a default, and it is only made where it is
   * certain: an Attempt that never reached Claude Code sent no message and spent
   * nothing. A Turn that began and produced no terminal event — a process that
   * died, a Retry Storm roma stopped waiting for — spent real tokens that nothing
   * will ever name, and recording those as zero would report money as free.
   */
  spentOn(credential: CredentialKind): Spend {
    // Whether a message has gone *by this point in the Task*, which is not a
    // question about this credential. Once one has, nothing after it can claim
    // to be free with certainty — and because `null ?? 0` is `0`, an Attempt
    // that never sent one would otherwise overwrite an earlier unpriced Attempt
    // and report real tokens as free.
    let sent = false
    // The money alone, because the two are accumulated differently and folding
    // them together would put a `compaction` in every literal below that neither
    // reads nor changes.
    let spend: Omit<Spend, 'compaction'> = NOTHING_SPENT
    let compaction: Compaction | null = null
    for (const attempt of this.#made) {
      sent ||= attempt.sent
      if (attempt.credential !== credential) continue
      compaction ??= attempt.compaction
      const turnMs = attempt.turn?.durationMs ?? spend.turnMs
      if (attempt.turn?.costUsd != null) {
        spend = { costUsd: (spend.costUsd ?? 0) + attempt.turn.costUsd, turnMs }
        continue
      }
      // Nothing priced this Attempt. What earlier ones were priced at stands, and
      // is now known to be less than the whole.
      spend = { costUsd: spend.costUsd ?? (sent ? null : 0), turnMs }
    }
    return { ...spend, compaction }
  }

  /** What Claude Code last said its credential resolved to, or null if it never did. */
  apiKeySource(): string | null {
    return this.#apiKeySource
  }

  /**
   * Book a wait on the Shared Window, or null where none is owed.
   *
   * Null where the last Attempt failed for any other reason — the reading is that
   * Attempt's own, cleared when it started, so a failure carrying none is a
   * failure the window had nothing to do with. Null too where the event will not
   * say when the window comes back: a Task parked against a moment that never
   * arrives waits for ever, and nothing else in roma would come and look at it.
   * And null once a Task has waited `MAX_PARKS` times.
   *
   * Says when the window comes back rather than how long to wait for it, and
   * touches no clock at all — `waitMsUntil` is the other half, called when the
   * timer is armed.
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
