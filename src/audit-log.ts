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

export type TaskOutcome = 'result' | 'failure' | 'stopped'

const OUTCOMES: readonly TaskOutcome[] = ['result', 'failure', 'stopped']

function isFigure(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isCompaction(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const { trigger, preTokens, postTokens } = value as Record<string, unknown>
  return (
    (trigger === null || typeof trigger === 'string') && isFigure(preTokens) && isFigure(postTokens)
  )
}

export type AuditKind = 'task' | 'relay'

const KINDS: readonly AuditKind[] = ['task', 'relay']

export interface AuditRecord {
  readonly at: string
  readonly taskId: string
  readonly kind?: AuditKind
  readonly caller: string
  readonly callerName?: string | null
  readonly sessionId: string | null
  readonly outcome: TaskOutcome
  readonly costUsd: number | null
  readonly durationMs: number
  readonly turnMs: number | null
  readonly credential: CredentialKind
  readonly runtime?: Runtime
  readonly model?: string
  readonly effort?: string
  readonly caveman?: string
  readonly outputTokens?: number | null
  readonly cloudReach?: boolean
  readonly documentReach?: boolean
  readonly compaction?: Compaction
  readonly apiKeySource: string | null
}

export type UnstampedRecord = Omit<AuditRecord, 'at'>

export interface AuditTotal {
  readonly month: string
  readonly tasks: number
  readonly relays: number
  readonly costUsd: number
  readonly unpriced: number
  readonly unreadable: number
  readonly mismatched: number
}

const CREDENTIALS: readonly CredentialKind[] = ['shared-window', 'overflow']

export interface CredentialSpend {
  readonly runtime: Runtime
  readonly credential: CredentialKind
  readonly tasks: number
  readonly relays: number
  readonly costUsd: number
  readonly unpriced: number
  readonly mismatched: number
}

export interface AuditBreakdown {
  readonly month: string
  readonly spend: readonly CredentialSpend[]
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

function paidAsIntended({ credential, apiKeySource }: AuditRecord): boolean {
  return apiKeySource === null || apiKeySource === apiKeySourceFor(credential)
}

export function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7)
}

export interface AuditLogOptions {
  readonly auditRoot: string
  readonly onWriteFailed?: (record: AuditRecord, error: unknown) => void
}

const reportToStderr = (record: AuditRecord, error: unknown): void => {
  const reason = error instanceof Error ? error.message : String(error)
  writeToStderr({ event: 'audit-write-failed', reason, record })
}

export class AuditLog {
  readonly #auditRoot: string
  readonly #onWriteFailed: (record: AuditRecord, error: unknown) => void

  constructor({ auditRoot, onWriteFailed = reportToStderr }: AuditLogOptions) {
    this.#auditRoot = auditRoot
    this.#onWriteFailed = onWriteFailed
    mkdirSync(auditRoot, { recursive: true })
  }

  record(task: UnstampedRecord): void {
    const at = new Date()
    const record: AuditRecord = { at: at.toISOString(), ...task }
    const line = `${JSON.stringify(record)}\n`
    try {
      const file = this.#fileFor(monthOf(at))
      appendFileSync(file, endsWhole(file) ? line : `\n${line}`, 'utf8')
    } catch (error) {
      this.#onWriteFailed(record, error)
    }
  }

  readMonth(month: string): AuditRecord[] {
    return this.#linesOf(month).flatMap((line) => {
      const record = readRecord(line)
      return record === null ? [] : [record]
    })
  }

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
      if (record.kind === 'relay') tally.relays += 1
      else tally.tasks += 1
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
