import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { CredentialKind } from './build-env.js'

/** How a Task ended, in the three ways a Conversation is ever told about. */
export type TaskOutcome = 'result' | 'failure' | 'stopped'

/**
 * One Task, as the audit log is told about it.
 *
 * Everything except when it happened, which the log stamps itself so that the
 * stamp and the month it is filed under cannot disagree.
 */
export interface AuditEntry {
  readonly taskId: string
  /**
   * Whoever sent the message, named however the Channel names people.
   *
   * The reason this file exists. Everyone shares one subscription token, so the
   * provider has no idea who any of this was for — ADR-0002 — and there is no
   * second place to go and look it up afterwards.
   */
  readonly caller: string
  /** Null for a Task that failed before roma could work out which Session it was for. */
  readonly sessionId: string | null
  readonly outcome: TaskOutcome
  /**
   * What this Task cost, as the per-Turn delta.
   *
   * Never `total_cost_usd` raw: that is cumulative for the process, so a fifth
   * Task logged raw is recorded at the sum of Tasks one through five, and the
   * monthly Overflow cap built on it would refuse spending that never happened.
   *
   * Zero where no Turn completed — a Task stopped before it started, or one
   * abandoned mid-retry-storm. That is a genuine zero rather than a missing
   * number in the second case too: the cost arrives on the terminal event, and a
   * Turn roma stopped waiting for never produced one.
   */
  readonly costUsd: number
  /**
   * How long the person waited: from the message arriving to being told how it
   * went, queueing and cold start included.
   *
   * The Task's own wall-clock rather than the Turn's, because it is the only one
   * that exists for every ending — a Task stopped while it was still queued
   * never had a Turn — and the only one that describes what was actually endured.
   */
  readonly durationMs: number
  /** How much of that was the Turn itself. Null where no Turn ran. */
  readonly turnMs: number | null
  /** The credential roma ran this Task on. */
  readonly credential: CredentialKind
  /**
   * What Claude Code said its credential resolved to — `apiKeySource` off
   * `system/init`, and null where no Turn reached that point.
   *
   * Recorded next to the credential above rather than instead of it, because the
   * two disagreeing is the failure ADR-0002 is most afraid of: a stray
   * `ANTHROPIC_API_KEY` silently moves every run onto metered billing, and the
   * only evidence is this field. Intent alone would record the reassuring half of
   * that, and the observation alone would lose what roma believed it was doing.
   */
  readonly apiKeySource: string | null
}

/** One Task's Audit Record, as it is written down. */
export type AuditRecord = AuditEntry & {
  /** When the Task ended, ISO-8601 in UTC. */
  readonly at: string
}

/** What a calendar month of Tasks came to. */
export interface AuditTotal {
  readonly month: string
  readonly tasks: number
  readonly costUsd: number
  /**
   * Records in this month that could not be read.
   *
   * Reported rather than thrown or ignored, because both of those answer the
   * Overflow cap's question wrongly: a total that refuses to be computed leaves
   * the cap unenforceable, and one that quietly skips a line under-reports spend
   * and lets the cap through. A caller that cares can refuse to spend while this
   * is above zero.
   */
  readonly unreadable: number
  /**
   * Records where the credential roma ran the Task on is not the one Claude Code
   * said was paying.
   *
   * Above zero means the total below is describing money that came out of
   * somewhere else, and the number to act on is which credential is really being
   * billed rather than this one.
   */
  readonly mismatched: number
}

/**
 * What `system/init.apiKeySource` reports under each credential.
 *
 * Both measured rather than assumed: `"none"` under the OAuth token, and
 * `"ANTHROPIC_API_KEY"` the moment a key is present — the same pair the startup
 * self-check asserts on, and the reason a stray key is detectable at all.
 */
const API_KEY_SOURCE: Record<CredentialKind, string> = {
  'shared-window': 'none',
  overflow: 'ANTHROPIC_API_KEY',
}

/**
 * Whether the credential roma ran a Task on is the one that paid for it.
 *
 * True where nothing was observed: a Task with no Turn behind it has no
 * `apiKeySource` and also spent nothing, so it is not evidence of anything.
 */
export function paidAsIntended({ credential, apiKeySource }: AuditRecord): boolean {
  return apiKeySource === null || apiKeySource === API_KEY_SOURCE[credential]
}

export interface AuditLogOptions {
  /**
   * Where the records go.
   *
   * Deliberately not under the Session Pool's work root: that directory is
   * walked by a reclaim that deletes anything nothing has touched for seven
   * days, and an audit log is exactly the thing that survives a quiet week.
   */
  readonly dir: string
  /**
   * Where a record goes when it cannot be written to disk. One JSON object per
   * line on stderr by default.
   */
  readonly onWriteFailed?: (record: AuditRecord, error: unknown) => void
}

/** The fallback: at least get the record into the process's log stream. */
const reportToStderr = (record: AuditRecord, error: unknown): void => {
  const reason = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${JSON.stringify({ event: 'audit-write-failed', reason, record })}\n`)
}

/**
 * Every Task roma has run, one line each, kept for as long as the disk keeps it.
 *
 * This is the only place per-user attribution exists. Everybody shares one
 * subscription token (ADR-0002), so the provider sees one customer and can never
 * be asked who spent what — the question is answerable here or nowhere.
 *
 * Two properties follow from what the records are for rather than from taste:
 *
 * - **A month is a file.** The monthly Overflow cap is a calendar-month sum, so
 *   the sum is one file read rather than a scan of everything roma has ever
 *   done, and a month that has passed is never appended to again.
 * - **A record is written where it can be read again.** Held in memory it would
 *   describe money right up until the next deploy and then be gone, which is the
 *   one failure this cannot have: the number it carries is not recoverable from
 *   anywhere else afterwards.
 */
export class AuditLog {
  readonly #dir: string
  readonly #onWriteFailed: (record: AuditRecord, error: unknown) => void

  constructor({ dir, onWriteFailed = reportToStderr }: AuditLogOptions) {
    this.#dir = dir
    this.#onWriteFailed = onWriteFailed
    // Here rather than at the first Task, so that a roma pointed at a directory
    // it cannot write to says so while it is starting — the boot is the last
    // moment anybody is watching, and a Task that discovers it is the first Task
    // whose cost is already lost.
    mkdirSync(dir, { recursive: true })
  }

  /**
   * Write one Task down.
   *
   * **Never throws**, and that is the design rather than an oversight. It is
   * called on the way to telling somebody how their Task went, and a Task that
   * ran, spent money and then answered nobody because the disk was full would be
   * the worse of the two failures. A record that cannot be written is handed to
   * `onWriteFailed` instead, which by default puts it on stderr — the container's
   * log stream is not the audit log, but it is somewhere, and somewhere beats the
   * only copy being dropped on the floor.
   */
  record(entry: AuditEntry): void {
    // Stamped here so that the time on the record and the month it is filed
    // under are one decision. A Task that started in July and ended in August is
    // an August record: the alternative is appending to a month that may already
    // have been totalled and acted on.
    const record: AuditRecord = { at: new Date().toISOString(), ...entry }
    const line = `${JSON.stringify(record)}\n`
    try {
      const file = this.#fileFor(monthOf(record.at))
      // Start a new line first if the file was left mid-line. A machine that
      // loses power mid-append leaves a line with no newline on the end of it,
      // and appending straight onto that joins the next record to the wreckage —
      // costing the month a second record, this one a Task that really did
      // happen. One torn line is the most a power loss may cost.
      //
      // Checked on every append rather than once per file per run. The cheaper
      // version assumes nothing else ever writes here, and the day something
      // does — a second roma over the same volume, somebody's script — the
      // assumption is not wrong loudly, it is wrong by silently eating a record.
      appendFileSync(file, endsWhole(file) ? line : `\n${line}`, 'utf8')
    } catch (error) {
      this.#onWriteFailed(record, error)
    }
  }

  /**
   * Every record of one calendar month, in the order the Tasks ended.
   *
   * UTC, because a month has to be a fixed set of records rather than one that
   * depends on where the reader is standing.
   */
  readMonth(month: string): AuditRecord[] {
    return this.#linesOf(month).flatMap((line) => {
      const record = readRecord(line)
      return record === null ? [] : [record]
    })
  }

  /**
   * What one calendar month came to, which is what the Overflow cap needs.
   *
   * Filtered by credential where the caller has one in mind: the cap is on
   * metered spend, and Shared Window Tasks are not spend in the sense it means.
   */
  totalFor(month: string, credential?: CredentialKind): AuditTotal {
    let tasks = 0
    let costUsd = 0
    let unreadable = 0
    let mismatched = 0

    for (const line of this.#linesOf(month)) {
      const record = readRecord(line)
      if (record === null) {
        unreadable += 1
        continue
      }
      if (credential !== undefined && record.credential !== credential) continue
      tasks += 1
      costUsd += record.costUsd
      if (!paidAsIntended(record)) mismatched += 1
    }

    return { month, tasks, costUsd, unreadable, mismatched }
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
    return join(this.#dir, `${month}.jsonl`)
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

/** The calendar month an ISO-8601 UTC stamp falls in. */
function monthOf(at: string): string {
  return at.slice(0, 7)
}

/**
 * Read one line back, or null if it is not a record.
 *
 * Tight about the fields a total is computed from and incurious about the rest:
 * a line whose cost is missing or is not a number would otherwise be summed as
 * nothing and reported as a Task that was free. A half-written last line is the
 * case this is really for — a machine that lost power mid-append leaves one, and
 * it must cost the month one record rather than all of them.
 */
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
  if (typeof record['costUsd'] !== 'number' || !Number.isFinite(record['costUsd'])) return null
  if (record['credential'] !== 'shared-window' && record['credential'] !== 'overflow') return null
  return record as unknown as AuditRecord
}
