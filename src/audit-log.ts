import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs'
import { join } from 'node:path'
import { apiKeySourceFor, type CredentialKind } from './build-env.js'
import { writeToStderr } from './operator-log.js'
import { RUNTIMES, type Runtime } from './runtime.js'
import type { Compaction } from './stream-events.js'

/** How a Task ended, in the three ways a Conversation is ever told about. */
export type TaskOutcome = 'result' | 'failure' | 'stopped'

const OUTCOMES: readonly TaskOutcome[] = ['result', 'failure', 'stopped']

/**
 * Whether a written figure is one this can be read back: a finite number, or the
 * null that says nothing reported one.
 *
 * Named for the shape rather than for the field, because several of them have it
 * and the null means something different in each — a Turn that began and was
 * never priced, a Turn that began and was never measured, and a Compaction the
 * stream said no token count for.
 */
function isFigure(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/** Enforced by `fence:audit-compaction-shape-not-fields`. */
function isCompaction(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const { trigger, preTokens, postTokens } = value as Record<string, unknown>
  return (
    (trigger === null || typeof trigger === 'string') && isFigure(preTokens) && isFigure(postTokens)
  )
}

/**
 * What kind of work one record describes: the shape the message took on the
 * wire, and nothing about what it cost.
 */
export type AuditKind = 'task' | 'relay'

const KINDS: readonly AuditKind[] = ['task', 'relay']

/** One Task — or one Relay — written down. */
export interface AuditRecord {
  /** When the Task ended, ISO-8601 in UTC. */
  readonly at: string
  readonly taskId: string
  /**
   * Whether this was a Task or a Relay. Optional, and **absent means `task`**.
   * Enforced by `fence:audit-old-records-stay-readable`.
   *
   * A record spelled `readout`, written before ADR-0018, is unreadable: dropped
   * by `readRecord` and counted in `unreadable`.
   */
  readonly kind?: AuditKind
  /** Whoever sent the message, named however the Channel names people. */
  readonly caller: string
  /**
   * The same person as a human reads them, in three states that mean three
   * different things:
   *
   * - a **name**, where the Channel had one;
   * - **null**, where it did not — an anonymous Chat user, or a delivery that
   *   carried no `displayName`;
   * - **absent**, where the record was written before ADR-0009 added the field.
   *
   * Optional for that last one. Enforced by `fence:audit-old-records-stay-readable`.
   */
  readonly callerName?: string | null
  /** Null for a Task that failed before roma could work out which Session it was for. */
  readonly sessionId: string | null
  readonly outcome: TaskOutcome
  /**
   * What this Task cost, as the per-Turn delta. Never `total_cost_usd` raw.
   * Enforced by `fence:session-cost-is-a-delta`.
   *
   * - a **number**, where a Turn ended and Claude Code priced it;
   * - **zero**, where no Turn ever began, so nothing was spent;
   * - **null**, where a Turn began and nothing ever priced it: unpriced, not
   *   free, and not to be added up as zero.
   */
  readonly costUsd: number | null
  /**
   * How long the person waited: from the message arriving to being told how it
   * went, queueing and cold start included.
   */
  readonly durationMs: number
  /** How much of that was the Turn itself. Null where no Turn ran. */
  readonly turnMs: number | null
  /** The credential roma ran this Task on. */
  readonly credential: CredentialKind
  /**
   * The Runtime that served this Task. Optional, and **absent means
   * `claude-code`**. Enforced by `fence:audit-old-records-stay-readable`.
   */
  readonly runtime?: Runtime
  /**
   * The model roma ran this Task on: the Session's Chosen Model, or the Pinned
   * Model where it had none. Written on every record, and optional only for
   * reading the past: **absent means the Pinned Model**.
   * Enforced by `fence:audit-old-records-stay-readable`.
   */
  readonly model?: string
  /**
   * What effort roma ran this Task at: the Session's Chosen Effort, the Pinned
   * Effort, or `EFFORT_NOT_APPLIED` where the Effort Matrix says the model takes
   * none. What roma *sent*, not what the process echoed, so weaker evidence than
   * `model`.
   *
   * Optional, and **absent reads as unknown rather than as the Pinned Effort** —
   * which is the one place this differs from `model`. Enforced by `fence:audit-old-records-stay-readable`.
   */
  readonly effort?: string
  /**
   * How short roma asked the model to be: the Caveman the process that served
   * this Task was spawned at, or `CAVEMAN_NOT_PINNED` where nothing named one.
   * The level the *process* ran at, not the record the pool would consult now: a
   * Chosen Caveman written during the Turn moves the next spawn and not this one.
   *
   * Optional, and **absent reads as unknown rather than as `off`**.
   * Enforced by `fence:audit-old-records-stay-readable`.
   */
  readonly caveman?: string
  /**
   * What the Turn produced, as the per-Turn delta. Never a running total:
   * `Turn.outputTokens` does the differencing, once.
   * Enforced by `fence:session-output-tokens-never-negative`.
   *
   * - a **number**, where a Turn ended and the terminal event reported usage;
   * - **zero**, where no Turn ever began, or where one produced nothing;
   * - **null**, where a Turn began and nothing measured it.
   *   Enforced by `fence:audit-unmeasured-is-not-zero`.
   *
   * Optional, and absent where a record was written before it. Enforced by `fence:audit-old-records-stay-readable`.
   */
  readonly outputTokens?: number | null
  /**
   * Whether this Task obtained a Cloud Token: a yes or a no, never a count, and
   * never what was reached for.
   *
   * Optional, and **absent means no**. Enforced by `fence:audit-old-records-stay-readable`.
   */
  readonly cloudReach?: boolean
  /**
   * Whether this Task obtained a Document Token: a yes or a no, never a count,
   * and never what was reached for. The token can outlive the Task by up to an
   * hour, so what it did may fall after `at`.
   *
   * Optional, and **absent means no**. Enforced by `fence:audit-old-records-stay-readable`.
   */
  readonly documentReach?: boolean
  /**
   * The Compaction that happened inside this Task, where one did. With `kind`
   * beside it, `trigger` says who asked.
   *
   * Optional, and **absent means no Compaction happened**.
   * Enforced by `fence:audit-old-records-stay-readable`.
   */
  readonly compaction?: Compaction
  /**
   * What Claude Code said its credential resolved to — `apiKeySource` off
   * `system/init`, and null where no Turn reached that point. Recorded beside
   * `credential`, not instead of it: the two disagreeing is what `mismatched`
   * counts.
   */
  readonly apiKeySource: string | null
}

/**
 * An Audit Record before it has been stamped: `at` is the one field a caller
 * does not supply, so the stamp and the month it is filed under are one decision.
 */
export type UnstampedRecord = Omit<AuditRecord, 'at'>

/**
 * What a calendar month of Tasks came to.
 *
 * `costUsd` is the number the Overflow cap is enforced on, and `unpriced`,
 * `unreadable` and `mismatched` are every way that number can be less than the
 * truth. None of them stops the total being returned, so a caller spending real
 * money against it should read them first.
 */
export interface AuditTotal {
  readonly month: string
  /**
   * Tasks in the month. Relays are **not** counted here; their cost is in
   * `costUsd` below. Enforced by `fence:audit-relays-counted-apart`.
   */
  readonly tasks: number
  /** Relays in the month, counted separately. */
  readonly relays: number
  /** What the month spent: everything that cost anything, Relays included. */
  readonly costUsd: number
  /**
   * Tasks in the total whose cost was never reported, which are in `tasks` but
   * not in `costUsd`: read the total as at least `costUsd`.
   */
  readonly unpriced: number
  /**
   * Records in this month that could not be read, reported rather than thrown
   * or skipped, and counted whatever credential was asked for. A caller that
   * cares can refuse to spend while this is above zero. Enforced by
   * `fence:audit-unreadable-counted-once`.
   */
  readonly unreadable: number
  /**
   * Records where the credential roma ran the Task on is not the one Claude Code
   * said was paying. Above zero, the total describes money that came out of
   * somewhere else.
   */
  readonly mismatched: number
}

/** Both credentials, for reading a record back and for the order a month reports them in. */
const CREDENTIALS: readonly CredentialKind[] = ['shared-window', 'overflow']

/**
 * What one credential drew in a calendar month, on one Runtime: `AuditTotal`'s
 * figures, counted over that pair's records alone. Not `unreadable`, which
 * belongs to the month.
 *
 * Kept apart from every other bucket and **never added to one**.
 * Enforced by `fence:audit-buckets-never-summed`.
 */
export interface CredentialSpend {
  readonly runtime: Runtime
  readonly credential: CredentialKind
  readonly tasks: number
  readonly relays: number
  readonly costUsd: number
  readonly unpriced: number
  /**
   * Records roma filed under this credential that Claude Code contradicted. Read
   * it for the month, and never print it beside this credential's figure: it says
   * the record's own `credential` is not to be believed.
   */
  readonly mismatched: number
}

/**
 * One calendar month, split by Runtime and credential, plus the one count that
 * can belong to neither. `totalFor` folds this down, so a caller that wants both
 * asks once. Enforced by `fence:audit-unreadable-counted-once`.
 */
export interface AuditBreakdown {
  readonly month: string
  /**
   * One entry per Runtime per credential, every combination always present, in
   * the order `RUNTIMES` and `CREDENTIALS` declare them.
   */
  readonly spend: readonly CredentialSpend[]
  /** The month's, and what `AuditTotal.unreadable` carries whole. */
  readonly unreadable: number
}

function sumOf(
  spend: readonly CredentialSpend[],
  field: keyof Omit<CredentialSpend, 'runtime' | 'credential'>,
) {
  return spend.reduce((total, entry) => total + entry[field], 0)
}

interface Tally {
  tasks: number
  relays: number
  costUsd: number
  unpriced: number
  mismatched: number
}

function nothingDrawn(): Tally {
  return { tasks: 0, relays: 0, costUsd: 0, unpriced: 0, mismatched: 0 }
}

function runtimeOf({ runtime }: AuditRecord): Runtime {
  return runtime ?? 'claude-code'
}

/**
 * Whether the credential roma ran a Task on is the one that paid for it.
 *
 * Asked against `apiKeySourceFor` rather than a table of its own, so that this
 * and the startup self-check cannot come to different conclusions about the same
 * credential. True where nothing was observed: a Task with no Turn behind it has
 * no `apiKeySource` and also spent nothing, so it is evidence of nothing.
 */
function paidAsIntended({ credential, apiKeySource }: AuditRecord): boolean {
  return apiKeySource === null || apiKeySource === apiKeySourceFor(credential)
}

/**
 * The calendar month a moment falls in, as the records of it are filed: UTC, so
 * a month is a fixed set of records wherever the reader stands.
 */
export function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7)
}

export interface AuditLogOptions {
  /**
   * Where the records go. Never under the Work Root. Enforced by
   * `fence:env-audit-root-outside-the-work-root`.
   */
  readonly auditRoot: string
  /**
   * Where a record goes when it cannot be written to disk. One JSON object per
   * line on stderr by default.
   */
  readonly onWriteFailed?: (record: AuditRecord, error: unknown) => void
}

/** The fallback: at least get the record into the process's log stream. */
const reportToStderr = (record: AuditRecord, error: unknown): void => {
  const reason = error instanceof Error ? error.message : String(error)
  writeToStderr({ event: 'audit-write-failed', reason, record })
}

/**
 * Every Task roma has run, one line each, kept for as long as the disk keeps it.
 * One file per calendar month, and a month that has passed is never appended to
 * again.
 */
export class AuditLog {
  readonly #auditRoot: string
  readonly #onWriteFailed: (record: AuditRecord, error: unknown) => void

  constructor({ auditRoot, onWriteFailed = reportToStderr }: AuditLogOptions) {
    this.#auditRoot = auditRoot
    this.#onWriteFailed = onWriteFailed
    // Here rather than at the first Task, so that a roma pointed at a directory
    // it cannot write to says so while it is starting — the boot is the last
    // moment anybody is watching, and a Task that discovers it is the first Task
    // whose cost is already lost.
    mkdirSync(auditRoot, { recursive: true })
  }

  /**
   * Write one Task down. **Never throws**: a record that cannot be written is
   * handed to `onWriteFailed` instead. Enforced by `fence:audit-record-never-throws`.
   */
  record(task: UnstampedRecord): void {
    // Stamped here so that the time on the record and the month it is filed
    // under are one decision. A Task that started in July and ended in August is
    // an August record: the alternative is appending to a month that may already
    // have been totalled and acted on.
    const at = new Date()
    const record: AuditRecord = { at: at.toISOString(), ...task }
    const line = `${JSON.stringify(record)}\n`
    try {
      const file = this.#fileFor(monthOf(at))
      // Enforced by `fence:audit-append-mends-a-torn-tail`.
      appendFileSync(file, endsWhole(file) ? line : `\n${line}`, 'utf8')
    } catch (error) {
      this.#onWriteFailed(record, error)
    }
  }

  /** Every record of one calendar month (see `monthOf`), in the order the Tasks ended. */
  readMonth(month: string): AuditRecord[] {
    return this.#linesOf(month).flatMap((line) => {
      const record = readRecord(line)
      return record === null ? [] : [record]
    })
  }

  /**
   * What one calendar month came to, per credential and unsummed: the only walk
   * of a month's file, which every other reading folds.
   * Enforced by `fence:audit-unreadable-counted-once`.
   */
  breakdownFor(month: string): AuditBreakdown {
    const drawn: Record<Runtime, Record<CredentialKind, Tally>> = {
      'claude-code': { 'shared-window': nothingDrawn(), overflow: nothingDrawn() },
    }
    let unreadable = 0

    for (const line of this.#linesOf(month)) {
      const record = readRecord(line)
      if (record === null) {
        unreadable += 1
        continue
      }
      const tally = drawn[runtimeOf(record)][record.credential]
      // A record written before Relays existed carries no kind and is a Task,
      // which is the only thing it can have been. A record written before the
      // ADR-0018 rename carries `readout` and never reaches here at all —
      // `readRecord` drops it, and it is counted in `unreadable` above.
      if (record.kind === 'relay') tally.relays += 1
      else tally.tasks += 1
      // Counted as having happened and left out of the money, which is the only
      // honest pair of answers: it happened, and what it cost is not knowable.
      if (record.costUsd === null) tally.unpriced += 1
      else tally.costUsd += record.costUsd
      if (!paidAsIntended(record)) tally.mismatched += 1
    }

    return {
      month,
      spend: RUNTIMES.flatMap((runtime) =>
        CREDENTIALS.map((credential) => ({ runtime, credential, ...drawn[runtime][credential] })),
      ),
      unreadable,
    }
  }

  /**
   * What one calendar month came to, which is what the Overflow cap needs.
   * Filtered by credential where one is given, and never by Runtime: every
   * Runtime's buckets are summed with the rest of their credential's.
   * `unreadable` is carried whole either way.
   */
  totalFor(month: string, credential?: CredentialKind): AuditTotal {
    const { spend, unreadable } = this.breakdownFor(month)
    const counted =
      credential === undefined ? spend : spend.filter((entry) => entry.credential === credential)

    return {
      month,
      tasks: sumOf(counted, 'tasks'),
      relays: sumOf(counted, 'relays'),
      costUsd: sumOf(counted, 'costUsd'),
      unpriced: sumOf(counted, 'unpriced'),
      unreadable,
      mismatched: sumOf(counted, 'mismatched'),
    }
  }

  /** A month nothing was written in reads as a month with nothing in it. */
  #linesOf(month: string): string[] {
    let contents: string
    try {
      contents = readFileSync(this.#fileFor(month), 'utf8')
    } catch {
      return []
    }
    return contents.split('\n').filter((line) => line.trim() !== '')
  }

  #fileFor(month: string): string {
    return join(this.#auditRoot, `${month}.jsonl`)
  }
}

/**
 * Whether a file ends on a line boundary — reading one byte, not the file.
 *
 * A month of records is as long as the month was busy, and this is asked on the
 * way to writing one. True for a file that is not there yet: nothing that does
 * not exist is torn.
 */
function endsWhole(file: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const { size } = fstatSync(fd)
    if (size === 0) return true
    const tail = Buffer.alloc(1)
    readSync(fd, tail, 0, 1, size - 1)
    return tail[0] === 0x0a
  } catch {
    return true
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Enforced by `fence:audit-record-is-what-it-is-for` and `fence:audit-unreadable-counted-once`. */
function readRecord(line: string): AuditRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record['at'] !== 'string' || typeof record['taskId'] !== 'string') return null
  if (typeof record['caller'] !== 'string') return null
  if (!OUTCOMES.includes(record['outcome'] as TaskOutcome)) return null
  if (!isFigure(record['costUsd'])) return null
  // Enforced by `fence:audit-old-records-stay-readable` and `fence:audit-wrong-type-is-torn`.
  if (record['kind'] !== undefined && !KINDS.includes(record['kind'] as AuditKind)) return null
  if (record['model'] !== undefined && typeof record['model'] !== 'string') return null
  if (record['effort'] !== undefined && typeof record['effort'] !== 'string') return null
  if (record['caveman'] !== undefined && typeof record['caveman'] !== 'string') return null
  if (record['outputTokens'] !== undefined && !isFigure(record['outputTokens'])) return null
  if (record['cloudReach'] !== undefined && typeof record['cloudReach'] !== 'boolean') return null
  if (record['documentReach'] !== undefined && typeof record['documentReach'] !== 'boolean') {
    return null
  }
  if (record['compaction'] !== undefined && !isCompaction(record['compaction'])) return null
  if (!CREDENTIALS.includes(record['credential'] as CredentialKind)) return null
  if (record['runtime'] !== undefined && !RUNTIMES.includes(record['runtime'] as Runtime)) {
    return null
  }
  return record as unknown as AuditRecord
}
