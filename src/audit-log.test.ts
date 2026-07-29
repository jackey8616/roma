import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditLog, type UnstampedRecord } from './audit-log.js'

/** The month the clock below is in, as the file on disk names it. */
const MONTH = '2026-07'

let dirs: string[] = []

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roma-audit-'))
  dirs.push(dir)
  return dir
}

/** One Task's worth of record, with the real cost of a real recorded Turn. */
function entry(overrides: Partial<UnstampedRecord> = {}): UnstampedRecord {
  return {
    taskId: 'task-one',
    caller: 'someone',
    sessionId: 'session-one',
    outcome: 'result',
    costUsd: 0.0103129,
    durationMs: 5900,
    turnMs: 3408,
    credential: 'shared-window',
    apiKeySource: 'none',
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('what a Task leaves behind', () => {
  // The whole point of writing it down: per-user attribution does not exist at
  // the provider, so a record roma held in memory would be the only copy of a
  // number nobody can reconstruct, thrown away on the next deploy.
  it('is still there for a roma that has restarted', () => {
    const dir = newDir()

    new AuditLog({ auditRoot: dir }).record(entry())

    // A second AuditLog over the same directory is what a restarted roma has.
    expect(new AuditLog({ auditRoot: dir }).totalFor(MONTH)).toEqual({
      month: MONTH,
      tasks: 1,
      costUsd: 0.0103129,
      unpriced: 0,
      unreadable: 0,
      mismatched: 0,
    })
  })

  // The one ending that would otherwise leave no trace at all: nobody was told
  // anything, the Turn produced nothing, and the Task still happened.
  it('records a Task that failed and one that was stopped, like any other', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })

    log.record(entry({ taskId: 'failed', outcome: 'failure', costUsd: 0, turnMs: null }))
    log.record(entry({ taskId: 'stopped', outcome: 'stopped', costUsd: 0.000625 }))

    expect(log.readMonth(MONTH).map((record) => [record.taskId, record.outcome])).toEqual([
      ['failed', 'failure'],
      ['stopped', 'stopped'],
    ])
  })

  it('carries who asked, which Session, how long it took, and what it cost', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })

    log.record(entry())

    expect(log.readMonth(MONTH)).toEqual([
      {
        at: '2026-07-29T10:00:00.000Z',
        taskId: 'task-one',
        caller: 'someone',
        sessionId: 'session-one',
        outcome: 'result',
        costUsd: 0.0103129,
        durationMs: 5900,
        turnMs: 3408,
        credential: 'shared-window',
        apiKeySource: 'none',
      },
    ])
  })
})

describe('adding a calendar month up', () => {
  // What the monthly Overflow cap is: a sum over a month and nothing else. A
  // record belongs to the month its Task ended in, so a month that has been
  // totalled and acted on is never appended to afterwards.
  it('counts the month asked for and no other', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ costUsd: 0.01 }))
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'))
    log.record(entry({ costUsd: 0.02 }))

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, costUsd: 0.01 })
    expect(log.totalFor('2026-08')).toMatchObject({ tasks: 1, costUsd: 0.02 })
  })

  it('adds up to nothing for a month nothing ran in', () => {
    const log = new AuditLog({ auditRoot: newDir() })

    expect(log.totalFor('2019-04')).toEqual({
      month: '2019-04',
      tasks: 0,
      costUsd: 0,
      unpriced: 0,
      unreadable: 0,
      mismatched: 0,
    })
  })

  // The cap is on metered spend. Shared Window Tasks cost money too, in quota
  // rather than in dollars, and a cap that counted them would refuse Overflow
  // for spending that never reached an invoice.
  it('counts one credential where that is what was asked', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ credential: 'shared-window', apiKeySource: 'none', costUsd: 0.01 }))
    log.record(
      entry({ credential: 'overflow', apiKeySource: 'ANTHROPIC_API_KEY', costUsd: 0.9 }),
    )

    expect(log.totalFor(MONTH, 'overflow')).toMatchObject({ tasks: 1, costUsd: 0.9 })
    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 2, costUsd: 0.91 })
  })

  // ADR-0002's silent-degradation mode, caught after the fact: roma believed it
  // was drawing on the subscription and Claude Code says a key was paying. The
  // total is still returned — refusing to answer would leave the cap
  // unenforceable — but it now says out loud that it is describing money that
  // came out of somewhere else.
  it('says how many Tasks were not paid for by the credential roma ran them on', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ credential: 'shared-window', apiKeySource: 'ANTHROPIC_API_KEY' }))
    log.record(entry({ credential: 'shared-window', apiKeySource: 'none' }))
    // No Turn reached `system/init`, so nothing paid and nothing disagrees.
    log.record(entry({ credential: 'shared-window', apiKeySource: null }))

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 3, mismatched: 1 })
  })
})

describe('reading records that a machine got half way through writing', () => {
  // A power loss mid-append leaves exactly this. Losing the month's total to it
  // would leave the cap unenforceable over one truncated line, and skipping it
  // silently would under-report spend and let the cap through.
  it('costs the month one record rather than all of them', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ costUsd: 0.01 }))
    appendFileSync(join(dir, `${MONTH}.jsonl`), '{"at":"2026-07-29T10:00:00.000Z","cos')
    log.record(entry({ costUsd: 0.02 }))

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 2, costUsd: 0.03, unreadable: 1 })
    expect(log.readMonth(MONTH)).toHaveLength(2)
  })

  // A line that parses but has no cost on it must not be totalled as a Task that
  // was free — that is under-reporting wearing the shape of a valid record.
  it('does not read a line with no cost on it as a Task that cost nothing', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    appendFileSync(join(dir, `${MONTH}.jsonl`), '{"at":"2026-07-29T10:00:00.000Z","taskId":"x"}\n')

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 0, unreadable: 1 })
  })

  // It would add up perfectly and answer none of the questions this file exists
  // for, which makes it unreadable here rather than a record with a hole in it.
  it('does not read a line that lost the caller as a record', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    const { caller, ...noCaller } = entry()
    void caller
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ at: '2026-07-29T10:00:00.000Z', ...noCaller })}\n`,
    )

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 0, unreadable: 1 })
  })
})

describe('a Task nothing ever priced', () => {
  // Its cost is not zero and not a number: the Turn began, tokens went out, and
  // the terminal event that would have priced them never arrived. Counted as a
  // Task and left out of the money, so a cap reading this knows the figure is a
  // floor rather than the answer.
  it('counts as a Task, stays out of the money, and says so', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ costUsd: 0.01 }))
    log.record(entry({ costUsd: null, outcome: 'failure', turnMs: null }))

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 2, costUsd: 0.01, unpriced: 1 })
  })

  it('is still a record that reads back', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })

    log.record(entry({ costUsd: null }))

    expect(log.readMonth(MONTH)).toMatchObject([{ costUsd: null }])
  })
})

describe('a record that cannot be written', () => {
  // It is written on the way to telling somebody how their Task went. A Task
  // that ran, spent money, and then answered nobody because the disk was full is
  // the worse of the two failures — so the record goes somewhere else instead of
  // the write becoming the Task's problem.
  it('does not become the failure of the Task it was describing', () => {
    const dir = newDir()
    const lost: unknown[] = []
    const log = new AuditLog({ auditRoot: dir, onWriteFailed: (record) => lost.push(record) })
    rmSync(dir, { recursive: true, force: true })

    expect(() => log.record(entry())).not.toThrow()
    expect(lost).toEqual([expect.objectContaining({ taskId: 'task-one', costUsd: 0.0103129 })])
  })

  // Somewhere beats nowhere: the container's log stream is not the audit log,
  // but a record on stderr can still be recovered by hand, and the only copy of
  // a number nobody can reconstruct must not be dropped on the floor.
  it('goes to stderr when nobody said where else to put it', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    const written: string[] = []
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    rmSync(dir, { recursive: true, force: true })

    log.record(entry())
    stderr.mockRestore()

    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0] ?? '')).toMatchObject({
      event: 'audit-write-failed',
      record: { taskId: 'task-one' },
    })
  })
})
