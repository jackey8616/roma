import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditLog, type UnstampedRecord } from './audit-log.js'
import { CAVEMAN_MENU, CAVEMAN_NOT_PINNED, OFF_MENU_WENYAN } from './caveman.js'
import { EFFORT_MENU, EFFORT_NOT_APPLIED } from './effort-menu.js'

const MONTH = '2026-07'

let dirs: string[] = []

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roma-audit-'))
  dirs.push(dir)
  return dir
}

function entry(overrides: Partial<UnstampedRecord> = {}): UnstampedRecord {
  return {
    taskId: 'task-one',
    caller: 'someone',
    callerName: 'Someone',
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

const OLD_RECORDS =
  'A record written before an optional field existed must still be readable, and an absent ' +
  'field left absent (ADR-0002: the Audit Record is the only per-user ledger, and the ' +
  'Overflow cap is enforced against its month). readRecord drops a line it cannot read and ' +
  'a dropped line leaves the month, so requiring a new field silently resets the month across ' +
  'the deploy that added it and lets the cap through; and reading an absent effort or Caveman ' +
  'as a level would invent a fact nobody recorded (ADR-0016, ADR-0030; #67, #81, #99, #110, ' +
  '#115, #132, #167, #192).'

const TORN =
  'An optional field that is present and of the wrong type makes the line unreadable, never a ' +
  'record with a hole in it or one read under the default (ADR-0002, ADR-0014, ADR-0015 §10, ' +
  'ADR-0016, ADR-0019, ADR-0022 §9, ADR-0030). Each field answers one question about who spent ' +
  'the month, and a line answering it with the wrong kind of value answers it wrongly; an ' +
  'unreadable line is reported, where a wrong one is not (#67, #81, #99, #110, #115, #132, ' +
  '#167, #192).'

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
  it('is still there for a roma that has restarted', () => {
    const dir = newDir()

    new AuditLog({ auditRoot: dir }).record(entry())

    expect(new AuditLog({ auditRoot: dir }).totalFor(MONTH)).toEqual({
      month: MONTH,
      tasks: 1,
      relays: 0,
      costUsd: 0.0103129,
      unpriced: 0,
      unreadable: 0,
      mismatched: 0,
    })
  })

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
        callerName: 'Someone',
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
      relays: 0,
      costUsd: 0,
      unpriced: 0,
      unreadable: 0,
      mismatched: 0,
    })
  })

  it('counts one credential where that is what was asked', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ credential: 'shared-window', apiKeySource: 'none', costUsd: 0.01 }))
    log.record(entry({ credential: 'overflow', apiKeySource: 'ANTHROPIC_API_KEY', costUsd: 0.9 }))

    expect(log.totalFor(MONTH, 'overflow')).toMatchObject({ tasks: 1, costUsd: 0.9 })
    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 2, costUsd: 0.91 })
  })

  it('says how many Tasks were not paid for by the credential roma ran them on', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ credential: 'shared-window', apiKeySource: 'ANTHROPIC_API_KEY' }))
    log.record(entry({ credential: 'shared-window', apiKeySource: 'none' }))
    log.record(entry({ credential: 'shared-window', apiKeySource: null }))

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 3, mismatched: 1 })
  })
})

describe('a calendar month split by credential', () => {
  const NEVER_SUMMED =
    'Each Runtime-and-credential bucket is kept apart and never added to another (ADR-0027, ' +
    'ADR-0025). A Shared Window Task carries a costUsd nobody is billed, so a sum across ' +
    'credentials reports subscription draw as money, and a sum across Runtimes reports two ' +
    'subscriptions as one (#167).'

  it('keeps the two apart, in the order a report reads them [fence:audit-buckets-never-summed]', () => {
    const log = new AuditLog({ auditRoot: newDir() })
    log.record(entry({ costUsd: 0.01 }))
    log.record(entry({ kind: 'relay', taskId: 'relay-one', costUsd: 0 }))
    log.record(entry({ credential: 'overflow', apiKeySource: 'ANTHROPIC_API_KEY', costUsd: 0.9 }))

    expect(log.breakdownFor(MONTH), NEVER_SUMMED).toEqual({
      month: MONTH,
      unreadable: 0,
      spend: [
        {
          runtime: 'claude-code',
          credential: 'shared-window',
          tasks: 1,
          relays: 1,
          costUsd: 0.01,
          unpriced: 0,
          mismatched: 0,
        },
        {
          runtime: 'claude-code',
          credential: 'overflow',
          tasks: 1,
          relays: 0,
          costUsd: 0.9,
          unpriced: 0,
          mismatched: 0,
        },
      ],
    })
  })

  it('counts a line it cannot read once, for the month rather than for a credential [fence:audit-unreadable-counted-once]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ costUsd: 0.01 }))
    appendFileSync(join(dir, `${MONTH}.jsonl`), '{"at":"2026-07-29T10:00:00.000Z","cos')

    const { spend, unreadable } = log.breakdownFor(MONTH)
    expect(unreadable, ONCE).toBe(1)
    expect(
      spend.map(({ credential, tasks }) => [credential, tasks]),
      ONCE,
    ).toEqual([
      ['shared-window', 1],
      ['overflow', 0],
    ])
    expect(
      log.totalFor(MONTH, 'shared-window').unreadable + log.totalFor(MONTH, 'overflow').unreadable,
      ONCE,
    ).toBe(2)
  })

  it('files an unpriced Turn and a credential that disagreed under their own', () => {
    const log = new AuditLog({ auditRoot: newDir() })
    log.record(entry({ apiKeySource: 'ANTHROPIC_API_KEY', costUsd: 0.02 }))
    log.record(entry({ credential: 'overflow', apiKeySource: 'ANTHROPIC_API_KEY', costUsd: null }))

    expect(log.breakdownFor(MONTH).spend).toMatchObject([
      { credential: 'shared-window', mismatched: 1, unpriced: 0 },
      { credential: 'overflow', mismatched: 0, unpriced: 1 },
    ])
  })

  it('reads a month nothing ran in as a month with nothing in it', () => {
    const log = new AuditLog({ auditRoot: newDir() })

    expect(log.breakdownFor('2019-04')).toEqual({
      month: '2019-04',
      unreadable: 0,
      spend: [
        {
          runtime: 'claude-code',
          credential: 'shared-window',
          tasks: 0,
          relays: 0,
          costUsd: 0,
          unpriced: 0,
          mismatched: 0,
        },
        {
          runtime: 'claude-code',
          credential: 'overflow',
          tasks: 0,
          relays: 0,
          costUsd: 0,
          unpriced: 0,
          mismatched: 0,
        },
      ],
    })
  })

  it('adds up to what the month’s total says, filtered and whole', () => {
    const log = new AuditLog({ auditRoot: newDir() })
    log.record(entry({ apiKeySource: 'ANTHROPIC_API_KEY', costUsd: 0.02 }))
    log.record(entry({ credential: 'overflow', apiKeySource: 'ANTHROPIC_API_KEY', costUsd: null }))

    expect(log.totalFor(MONTH)).toMatchObject({
      tasks: 2,
      costUsd: 0.02,
      unpriced: 1,
      mismatched: 1,
    })
    expect(log.totalFor(MONTH, 'overflow')).toMatchObject({
      tasks: 1,
      costUsd: 0,
      unpriced: 1,
      mismatched: 0,
    })
  })
})

const ONCE =
  'An unreadable line is counted, once, for the month: never thrown, never skipped, never ' +
  'counted per bucket (ADR-0002, ADR-0027). Thrown, the total cannot be computed and the ' +
  'Overflow cap is unenforceable; skipped, spend is under-reported and the cap let through; ' +
  'walked once per credential, one torn record is reported as two (#28, #167).'
const FOR_WHAT_IT_IS_FOR =
  'readRecord checks a line against what a record is for, not what a total needs (ADR-0002). ' +
  'A line that lost `caller` adds up perfectly and answers nothing; a line with no cost would ' +
  'be summed as a Task that was free (#28).'

describe('reading records that a machine got half way through writing', () => {
  it('costs the month one record rather than all of them [fence:audit-unreadable-counted-once]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ costUsd: 0.01 }))
    appendFileSync(join(dir, `${MONTH}.jsonl`), '{"at":"2026-07-29T10:00:00.000Z","cos')
    log.record(entry({ costUsd: 0.02 }))

    expect(log.totalFor(MONTH), ONCE).toMatchObject({ tasks: 2, costUsd: 0.03, unreadable: 1 })
    expect(log.readMonth(MONTH), ONCE).toHaveLength(2)
  })

  it('starts the next record on a line of its own, however the file came to be torn [fence:audit-append-mends-a-torn-tail]', () => {
    const why =
      'Every append starts a new line first when the file ends mid-line, checked on every ' +
      'append rather than once per file per run (ADR-0002: the month is the figure the ' +
      'Overflow cap is enforced against). A power loss leaves a line with no newline, and ' +
      'appending onto it joins the next record to the wreckage, so a Task that really happened ' +
      'leaves the month too; a once-per-run check misses whatever else wrote to the file ' +
      'since, a second roma over the same volume or somebody’s script (#28).'
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ taskId: 'before', costUsd: 0.01 }))
    appendFileSync(join(dir, `${MONTH}.jsonl`), '{"at":"2026-07-29T10:00:00.000Z","cos')
    log.record(entry({ taskId: 'after', costUsd: 0.02 }))

    expect(
      log.readMonth(MONTH).map(({ taskId }) => taskId),
      why,
    ).toEqual(['before', 'after'])
  })

  it('does not read a line with no cost on it as a Task that cost nothing [fence:audit-record-is-what-it-is-for]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    const { costUsd, ...noCost } = entry()
    void costUsd
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ at: '2026-07-29T10:00:00.000Z', ...noCost })}\n`,
    )

    expect(log.totalFor(MONTH), FOR_WHAT_IT_IS_FOR).toMatchObject({ tasks: 0, unreadable: 1 })
  })

  it('does not read a line that lost the caller as a record [fence:audit-record-is-what-it-is-for]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    const { caller, ...noCaller } = entry()
    void caller
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ at: '2026-07-29T10:00:00.000Z', ...noCaller })}\n`,
    )

    expect(log.totalFor(MONTH), FOR_WHAT_IT_IS_FOR).toMatchObject({ tasks: 0, unreadable: 1 })
  })

  it('reads a record written before the caller had a name on it [fence:audit-old-records-stay-readable]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    const { callerName, ...beforeTheField } = entry()
    void callerName
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ at: '2026-07-29T10:00:00.000Z', ...beforeTheField })}\n`,
    )

    expect(log.totalFor(MONTH), OLD_RECORDS).toMatchObject({
      tasks: 1,
      costUsd: 0.0103129,
      unreadable: 0,
    })
    expect(log.readMonth(MONTH)[0]?.caller, OLD_RECORDS).toBe('someone')
  })
})

describe('a Task nothing ever priced', () => {
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
  const NEVER_THROWS =
    'AuditLog.record must never throw; a record it cannot write goes to onWriteFailed, stderr ' +
    'by default (ADR-0002). It is called on the way to telling somebody how their Task went, ' +
    'and a Task that ran, spent money and then answered nobody because the disk was full is ' +
    'the worse of the two failures (#28).'

  it('does not become the failure of the Task it was describing [fence:audit-record-never-throws]', () => {
    const dir = newDir()
    const lost: unknown[] = []
    const log = new AuditLog({ auditRoot: dir, onWriteFailed: (record) => lost.push(record) })
    rmSync(dir, { recursive: true, force: true })

    expect(() => log.record(entry()), NEVER_THROWS).not.toThrow()
    expect(lost, NEVER_THROWS).toEqual([
      expect.objectContaining({ taskId: 'task-one', costUsd: 0.0103129 }),
    ])
  })

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

describe('telling a Relay from a Task', () => {
  const APART =
    '`tasks` must not count Relays (ADR-0018). It is read as "how much work did this month ' +
    'ask for"; folded in, a Conversation where somebody checked /context forty times reads as ' +
    'forty Tasks (#120).'

  it('counts them apart [fence:audit-relays-counted-apart]', () => {
    const log = new AuditLog({ auditRoot: newDir() })

    log.record(entry())
    log.record(entry({ kind: 'relay', taskId: 'relay-one', costUsd: 0 }))
    log.record(entry({ kind: 'relay', taskId: 'relay-two', costUsd: 0 }))

    expect(log.totalFor(MONTH), APART).toMatchObject({ tasks: 1, relays: 2 })
  })

  it('reads a record with no kind as a Task [fence:audit-old-records-stay-readable]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry())

    const [record] = log.readMonth(MONTH)
    expect(record?.kind, OLD_RECORDS).toBeUndefined()
    expect(log.totalFor(MONTH), OLD_RECORDS).toMatchObject({ tasks: 1, relays: 0, unreadable: 0 })
  })

  it('keeps the kind across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ kind: 'relay', costUsd: 0 }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.kind).toBe('relay')
  })

  it('drops a record written under the retired spelling', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ costUsd: 0.01 }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), kind: 'readout', costUsd: 0.05, at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH)).toMatchObject({
      tasks: 1,
      relays: 0,
      unreadable: 1,
      costUsd: 0.01,
    })
  })

  it('refuses a kind it does not know [fence:audit-wrong-type-is-torn]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry())
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), kind: 'something-later', at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH), TORN).toMatchObject({ tasks: 1, relays: 0, unreadable: 1 })
  })

  it('puts what a Relay spent into the month', () => {
    const log = new AuditLog({ auditRoot: newDir() })

    log.record(entry({ costUsd: 0.01 }))
    log.record(entry({ kind: 'relay', taskId: 'compacted', costUsd: 0.05 }))

    expect(log.totalFor(MONTH)).toMatchObject({
      tasks: 1,
      relays: 1,
      costUsd: 0.060000000000000005,
    })
  })
})

describe('which Runtime served a Task', () => {
  it('keeps the Runtime across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ runtime: 'claude-code' }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.runtime).toBe('claude-code')
  })

  it('reads a record with no Runtime on it as Claude Code’s [fence:audit-old-records-stay-readable]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ costUsd: 0.01 }))

    const [record] = log.readMonth(MONTH)
    expect(record?.runtime, OLD_RECORDS).toBeUndefined()
    expect(log.totalFor(MONTH), OLD_RECORDS).toMatchObject({
      tasks: 1,
      unreadable: 0,
      costUsd: 0.01,
    })
    expect(log.breakdownFor(MONTH).spend, OLD_RECORDS).toMatchObject([
      { runtime: 'claude-code', credential: 'shared-window', tasks: 1, costUsd: 0.01 },
      { runtime: 'claude-code', credential: 'overflow', tasks: 0 },
    ])
  })

  it('refuses a Runtime it does not know [fence:audit-wrong-type-is-torn]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ costUsd: 0.01 }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), runtime: 'codex', costUsd: 0.05, at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH), TORN).toMatchObject({ tasks: 1, unreadable: 1, costUsd: 0.01 })
  })

  it('keeps an unreadable line the month’s, whatever the month is split by', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ costUsd: 0.01 }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), runtime: 'codex', at: new Date().toISOString() })}\n`,
    )

    const { spend, unreadable } = log.breakdownFor(MONTH)
    expect(unreadable).toBe(1)
    expect(spend.some((bucket) => 'unreadable' in bucket)).toBe(false)
    expect(spend.map(({ runtime, tasks }) => [runtime, tasks])).toEqual([
      ['claude-code', 1],
      ['claude-code', 0],
    ])
  })

  it('leaves what the Overflow cap reads exactly where it was', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ costUsd: 0.01 }))
    log.record(entry({ credential: 'overflow', apiKeySource: 'ANTHROPIC_API_KEY', costUsd: 0.9 }))
    log.record(entry({ credential: 'overflow', apiKeySource: 'ANTHROPIC_API_KEY', costUsd: null }))
    log.record(
      entry({
        credential: 'overflow',
        apiKeySource: 'none',
        costUsd: 0.05,
        runtime: 'claude-code',
      }),
    )
    appendFileSync(join(dir, `${MONTH}.jsonl`), '{"at":"2026-07-29T10:00:00.000Z","cos')

    expect(log.totalFor(MONTH, 'overflow')).toEqual({
      month: MONTH,
      tasks: 3,
      relays: 0,
      costUsd: 0.9500000000000001,
      unpriced: 1,
      unreadable: 1,
      mismatched: 1,
    })
  })
})

describe('which model spent the month', () => {
  it('keeps the model across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ model: 'claude-opus-5' }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.model).toBe('claude-opus-5')
  })

  it('reads a record written before a Session could be moved [fence:audit-old-records-stay-readable]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), at: new Date().toISOString() })}\n`,
    )

    const [record] = log.readMonth(MONTH)
    expect(record?.model, OLD_RECORDS).toBeUndefined()
    expect(log.totalFor(MONTH), OLD_RECORDS).toMatchObject({
      tasks: 1,
      unreadable: 0,
      costUsd: 0.0103129,
    })
  })

  it('refuses a model that is not a name [fence:audit-wrong-type-is-torn]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ model: 'claude-sonnet-5' }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), model: 5, at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH), TORN).toMatchObject({ tasks: 1, unreadable: 1 })
  })
})

describe('what effort spent the month', () => {
  it('keeps the effort across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ effort: 'max' }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.effort).toBe('max')
  })

  it('reads a record written before roma knew what effort it was running at [fence:audit-old-records-stay-readable]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), at: new Date().toISOString() })}\n`,
    )

    const [record] = log.readMonth(MONTH)
    expect(record?.effort, OLD_RECORDS).toBeUndefined()
    expect(log.totalFor(MONTH), OLD_RECORDS).toMatchObject({
      tasks: 1,
      unreadable: 0,
      costUsd: 0.0103129,
    })
  })

  it('keeps a record that says the effort did not apply at all', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ model: 'claude-haiku-4-5', effort: EFFORT_NOT_APPLIED }))

    const [record] = log.readMonth(MONTH)
    expect(record?.effort).toBe(EFFORT_NOT_APPLIED)
    expect(EFFORT_MENU).not.toContain(record?.effort)
  })

  it('refuses an effort that is not a name [fence:audit-wrong-type-is-torn]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ effort: 'high' }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), effort: 3, at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH), TORN).toMatchObject({ tasks: 1, unreadable: 1 })
  })
})

describe('how short a Task was asked to be', () => {
  it('keeps the Caveman across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ caveman: 'ultra' }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.caveman).toBe('ultra')
  })

  it('reads a record written before roma knew how short it had asked for [fence:audit-old-records-stay-readable]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), at: new Date().toISOString() })}\n`,
    )

    const [record] = log.readMonth(MONTH)
    expect(record?.caveman, OLD_RECORDS).toBeUndefined()
    expect(log.totalFor(MONTH), OLD_RECORDS).toMatchObject({
      tasks: 1,
      unreadable: 0,
      costUsd: 0.0103129,
    })
  })

  it('keeps a record that says nothing named a Caveman at all', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ caveman: CAVEMAN_NOT_PINNED }))

    const [record] = log.readMonth(MONTH)
    expect(record?.caveman).toBe(CAVEMAN_NOT_PINNED)
    expect(CAVEMAN_MENU).not.toContain(record?.caveman)
    expect(OFF_MENU_WENYAN).not.toContain(record?.caveman)
  })

  it('refuses a Caveman that is not a name [fence:audit-wrong-type-is-torn]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ caveman: 'lite' }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), caveman: 2, at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH), TORN).toMatchObject({ tasks: 1, unreadable: 1 })
  })
})

describe('what a Task produced', () => {
  const UNMEASURED =
    'outputTokens must keep zero and null apart (ADR-0030, its first verification question). ' +
    'Zero is a Turn that produced nothing; null is a Turn that began and nothing measured. ' +
    'Written as zero, an unmeasured Turn reports real work as nothing, and a month compared ' +
    'against another reads the wrong way round, flattering the setting under test (#192).'

  it('keeps the output tokens across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ outputTokens: 1978 }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.outputTokens).toBe(1978)
  })

  it('reads a record written before roma wrote down what a Turn produced [fence:audit-old-records-stay-readable]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), at: new Date().toISOString() })}\n`,
    )

    const [record] = log.readMonth(MONTH)
    expect(record?.outputTokens, OLD_RECORDS).toBeUndefined()
    expect(log.totalFor(MONTH), OLD_RECORDS).toMatchObject({
      tasks: 1,
      unreadable: 0,
      costUsd: 0.0103129,
    })
  })

  it('tells a Task that produced nothing from one nothing measured [fence:audit-unmeasured-is-not-zero]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })

    log.record(entry({ taskId: 'produced-nothing', outputTokens: 0 }))
    log.record(entry({ taskId: 'never-measured', outputTokens: null }))

    expect(
      log.readMonth(MONTH).map((record) => [record.taskId, record.outputTokens]),
      UNMEASURED,
    ).toEqual([
      ['produced-nothing', 0],
      ['never-measured', null],
    ])
  })

  it('refuses a figure that is not one [fence:audit-wrong-type-is-torn]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ outputTokens: 21 }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), outputTokens: 'lots', at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH), TORN).toMatchObject({ tasks: 1, unreadable: 1 })
  })
})

describe('whether a Task used the Cloud Reach', () => {
  it('keeps the answer across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ cloudReach: true }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.cloudReach).toBe(true)
  })

  it('reads a record written before there was a cloud to reach [fence:audit-old-records-stay-readable]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), at: new Date().toISOString() })}\n`,
    )

    const [record] = log.readMonth(MONTH)
    expect(record?.cloudReach, OLD_RECORDS).toBeUndefined()
    expect(log.totalFor(MONTH), OLD_RECORDS).toMatchObject({ tasks: 1, unreadable: 0 })
  })

  it('refuses an answer that is not a yes or a no [fence:audit-wrong-type-is-torn]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ cloudReach: false }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), cloudReach: 3, at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH), TORN).toMatchObject({ tasks: 1, unreadable: 1 })
  })
})

describe('whether a Task used the Document Reach', () => {
  it('keeps the answer across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ documentReach: true }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.documentReach).toBe(true)
  })

  it('reads a record written before there were documents to reach [fence:audit-old-records-stay-readable]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), cloudReach: true, at: new Date().toISOString() })}\n`,
    )

    const [record] = log.readMonth(MONTH)
    expect(record?.documentReach, OLD_RECORDS).toBeUndefined()
    expect(log.totalFor(MONTH), OLD_RECORDS).toMatchObject({ tasks: 1, unreadable: 0 })
  })

  it('refuses an answer that is not a yes or a no [fence:audit-wrong-type-is-torn]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ documentReach: false }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), documentReach: 3, at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH), TORN).toMatchObject({ tasks: 1, unreadable: 1 })
  })

  it('keeps its answer apart from the cloud’s', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ cloudReach: false, documentReach: true }))

    const [record] = log.readMonth(MONTH)
    expect(record).toMatchObject({ cloudReach: false, documentReach: true })
  })
})

describe('whether a Compaction happened inside a Task', () => {
  const SHAPE =
    'A written Compaction is checked for its shape, never for its fields: every one is ' +
    'nullable on the way in, because the stream is not roma’s (ADR-0019). Requiring non-null ' +
    'token counts makes readRecord drop the line, and the record and its cost leave the ' +
    'month — when "a Compaction happened" still answers why this Task cost five times its ' +
    'neighbours (#115).'

  const COMPACTION = { trigger: 'auto', preTokens: 61486, postTokens: 1375 } as const

  it('keeps what happened across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ compaction: COMPACTION }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.compaction).toEqual(COMPACTION)
  })

  it('reads a record written before roma could see one [fence:audit-old-records-stay-readable]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), at: new Date().toISOString() })}\n`,
    )

    const [record] = log.readMonth(MONTH)
    expect(record?.compaction, OLD_RECORDS).toBeUndefined()
    expect(log.totalFor(MONTH), OLD_RECORDS).toMatchObject({ tasks: 1, unreadable: 0 })
  })

  it('refuses a line whose Compaction is not one [fence:audit-wrong-type-is-torn]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ compaction: COMPACTION }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), compaction: 'auto', at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH), TORN).toMatchObject({ tasks: 1, unreadable: 1 })
  })

  it('reads one whose fields the stream did not fill in [fence:audit-compaction-shape-not-fields]', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ compaction: { trigger: null, preTokens: null, postTokens: null } }))

    expect(log.readMonth(MONTH)[0]?.compaction, SHAPE).toEqual({
      trigger: null,
      preTokens: null,
      postTokens: null,
    })
  })
})
