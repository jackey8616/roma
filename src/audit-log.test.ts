import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditLog, type UnstampedRecord } from './audit-log.js'
import { EFFORT_MENU, EFFORT_NOT_APPLIED } from './effort-menu.js'

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
      relays: 0,
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
      relays: 0,
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

  // Every record roma wrote before ADR-0009 has no `callerName` on it, and the
  // month's total is the figure the Overflow cap is enforced against. Reading
  // those as unreadable would reset the month to whatever has been written since
  // and let the cap through — which is exactly why `callerName` went beside
  // `caller` rather than inside it.
  it('reads a record written before the caller had a name on it', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    const { callerName, ...beforeTheField } = entry()
    void callerName
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ at: '2026-07-29T10:00:00.000Z', ...beforeTheField })}\n`,
    )

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, costUsd: 0.0103129, unreadable: 0 })
    expect(log.readMonth(MONTH)[0]?.caller).toBe('someone')
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

describe('telling a Relay from a Task', () => {
  // The reason the field exists. Folded into `tasks`, a Conversation where
  // somebody checked `/context` forty times reads as forty Tasks.
  it('counts them apart', () => {
    const log = new AuditLog({ auditRoot: newDir() })

    log.record(entry())
    log.record(entry({ kind: 'relay', taskId: 'relay-one', costUsd: 0 }))
    log.record(entry({ kind: 'relay', taskId: 'relay-two', costUsd: 0 }))

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, relays: 2 })
  })

  // A record written before ADR-0012 has no kind and can only ever have been a
  // Task. It must still be readable: `readRecord` drops what it cannot read, and
  // a dropped line leaves the month the Overflow cap is enforced against.
  it('reads a record with no kind as a Task', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry())

    const [record] = log.readMonth(MONTH)
    expect(record?.kind).toBeUndefined()
    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, relays: 0, unreadable: 0 })
  })

  it('keeps the kind across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ kind: 'relay', costUsd: 0 }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.kind).toBe('relay')
  })

  // **The ADR-0018 rename is a breaking change to the ledger, and this is what
  // it breaks.** `readout` is what every Relay record written before the rename
  // says, and it is now a kind this version cannot name — so those lines are
  // dropped and their cost leaves the month's `costUsd`, which is the figure the
  // Overflow cap is enforced against. Chosen with that in view: the alternative
  // is a synonym that can never be deleted. It is not silent — the lines are
  // counted in `unreadable` — and it is avoidable by scheduling, which is why
  // this lands at a month boundary and the loss falls entirely in a closed month.
  it('drops a record written under the retired spelling', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ costUsd: 0.01 }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), kind: 'readout', costUsd: 0.05, at: new Date().toISOString() })}\n`,
    )

    // The five cents are gone from the month, not merely uncounted as a Relay.
    expect(log.totalFor(MONTH)).toMatchObject({
      tasks: 1,
      relays: 0,
      unreadable: 1,
      costUsd: 0.01,
    })
  })

  // A kind this version cannot name is unreadable rather than assumed to be a
  // Task. Guessing would defeat the whole point of the field — one kind read as
  // the other is exactly what it exists to prevent — and an unreadable line is
  // reported, where a wrong one is not.
  it('refuses a kind it does not know', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry())
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), kind: 'something-later', at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, relays: 0, unreadable: 1 })
  })

  // What the record is insurance against, and since ADR-0018 it is also the
  // ordinary case. Most of the Relay list is expected to cost nothing on the
  // pinned build and the list is a person's judgement, so a cost that turns up
  // on one of those is summed like any other — and a `/compact` is expected to
  // cost money and is summed the same way. Either way it reaches the figure the
  // Overflow cap is enforced on.
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

/**
 * ADR-0014: a Chosen Model is a Caller moving the shared bill, and nothing else
 * would remember which Task did.
 */
describe('which model spent the month', () => {
  it('keeps the model across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ model: 'claude-opus-5' }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.model).toBe('claude-opus-5')
  })

  // Every record roma wrote before ADR-0014 lacks the field and ran on the
  // Pinned Model, because nothing else was reachable. Requiring it would make all
  // of them unreadable at once — and `readRecord` drops what it cannot read, so
  // the month the Overflow cap is enforced against would silently reset across
  // the deploy that added the field.
  it('reads a record written before a Session could be moved', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), at: new Date().toISOString() })}\n`,
    )

    const [record] = log.readMonth(MONTH)
    expect(record?.model).toBeUndefined()
    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, unreadable: 0, costUsd: 0.0103129 })
  })

  // Absent is the Pinned Model; present and not a name is a torn line. Counted
  // as unreadable rather than read as a record with a hole in it, for the reason
  // a missing cost is: the one question this field answers is which model spent
  // the shared window, and a line that answers it with a number answers it
  // wrongly.
  it('refuses a model that is not a name', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ model: 'claude-sonnet-5' }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), model: 5, at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, unreadable: 1 })
  })
})

/**
 * ADR-0016: the same argument as the model beside it, for a setting roma has
 * weaker evidence about — and the record has to be spelled so that the
 * difference is visible.
 */
describe('what effort spent the month', () => {
  it('keeps the effort across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ effort: 'max' }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.effort).toBe('max')
  })

  /**
   * The one place this differs from `model`, and it is not a formality.
   *
   * An absent `model` reads as the Pinned Model, because nothing else was
   * reachable before ADR-0014. An absent `effort` reads as **unknown**: a record
   * written before this field ran on whatever the shared settings file happened
   * to say, and roma genuinely does not know what that was. Labelling those
   * retroactively would be inventing a fact — the discipline `costUsd` already
   * keeps by distinguishing free from unpriced.
   */
  it('reads a record written before roma knew what effort it was running at', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), at: new Date().toISOString() })}\n`,
    )

    const [record] = log.readMonth(MONTH)
    // Absent, and left absent. Nothing here fills it in with the Pinned Effort.
    expect(record?.effort).toBeUndefined()
    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, unreadable: 0, costUsd: 0.0103129 })
  })

  // Where the Effort Matrix says the model takes none, the record says that
  // rather than naming a level nothing ran at — and the word is deliberately not
  // spelled like a level, so a ledger read months later cannot mistake it for
  // one.
  it('keeps a record that says the effort did not apply at all', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ model: 'claude-haiku-4-5', effort: EFFORT_NOT_APPLIED }))

    const [record] = log.readMonth(MONTH)
    expect(record?.effort).toBe(EFFORT_NOT_APPLIED)
    expect(EFFORT_MENU).not.toContain(record?.effort)
  })

  it('refuses an effort that is not a name', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ effort: 'high' }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), effort: 3, at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, unreadable: 1 })
  })
})

/**
 * ADR-0015 §10: whoever pays the Google Cloud bill can narrow unexplained
 * activity on the service account to the Tasks that touched it.
 */
describe('whether a Task used the Cloud Reach', () => {
  it('keeps the answer across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ cloudReach: true }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.cloudReach).toBe(true)
  })

  // Every record roma wrote before there were Cloud Reaches lacks the field, and
  // none of those Tasks could have obtained a Cloud Token — there was no way to.
  // Requiring it would make all of them unreadable at once, which is the failure
  // `model` and `callerName` already carry the reasoning for: a dropped line
  // leaves the month's total, and the month's total is what the Overflow cap is
  // enforced against.
  it('reads a record written before there was a cloud to reach', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), at: new Date().toISOString() })}\n`,
    )

    const [record] = log.readMonth(MONTH)
    expect(record?.cloudReach).toBeUndefined()
    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, unreadable: 0 })
  })

  // A yes or a no. A line answering with a number is answering a different
  // question — the count ADR-0015 refused, because one token does unlimited API
  // calls for an hour and a number would be read as a measure of what was done.
  it('refuses an answer that is not a yes or a no', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ cloudReach: false }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), cloudReach: 3, at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, unreadable: 1 })
  })
})

describe('whether a Compaction happened inside a Task', () => {
  /** As the reader hands one over, off a real `system/compact_boundary`. */
  const COMPACTION = { trigger: 'auto', preTokens: 61486, postTokens: 1375 } as const

  // The largest unexplained variation there is in what a Task costs — 4.9 times
  // a quiet Turn, measured — and the record is the only place the question is
  // answerable afterwards.
  it('keeps what happened across a restart', () => {
    const dir = newDir()
    new AuditLog({ auditRoot: dir }).record(entry({ compaction: COMPACTION }))

    const [record] = new AuditLog({ auditRoot: dir }).readMonth(MONTH)
    expect(record?.compaction).toEqual(COMPACTION)
  })

  // Absent is no Compaction, which is what every record written before roma could
  // see one says. Requiring it would make all of them unreadable at once — a
  // dropped line leaves the month's total, and the month's total is what the
  // Overflow cap is enforced against.
  it('reads a record written before roma could see one', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), at: new Date().toISOString() })}\n`,
    )

    const [record] = log.readMonth(MONTH)
    expect(record?.compaction).toBeUndefined()
    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, unreadable: 0 })
  })

  // A torn line rather than a record with a hole in it. This field is the whole
  // account of why one Task cost several times what its neighbours did, and a
  // line answering it with a string answers it wrongly.
  it('refuses a line whose Compaction is not one', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ compaction: COMPACTION }))
    appendFileSync(
      join(dir, `${MONTH}.jsonl`),
      `${JSON.stringify({ ...entry(), compaction: 'auto', at: new Date().toISOString() })}\n`,
    )

    expect(log.totalFor(MONTH)).toMatchObject({ tasks: 1, unreadable: 1 })
  })

  // The stream is not roma's, and a build that stopped reporting the trigger
  // would still have compacted. What is checked is the shape, because that is the
  // part a torn line loses — and "a Compaction happened" is still the answer to
  // why this Task cost what it did.
  it('reads one whose fields the stream did not fill in', () => {
    const dir = newDir()
    const log = new AuditLog({ auditRoot: dir })
    log.record(entry({ compaction: { trigger: null, preTokens: null, postTokens: null } }))

    expect(log.readMonth(MONTH)[0]?.compaction).toEqual({
      trigger: null,
      preTokens: null,
      postTokens: null,
    })
  })
})
