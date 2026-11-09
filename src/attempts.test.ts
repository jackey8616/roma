import { describe, expect, it } from 'vitest'
import { COMPACTED, quotaEvent } from '../test/support/recorded-stream.js'
import { Attempts, waitMsUntil } from './attempts.js'
import type { Turn } from './claude-session.js'
import { readCompaction, readSharedWindow, type SharedWindow } from './stream-events.js'

const ALLOWED = readSharedWindow(quotaEvent())!
const spent = (fields: Record<string, unknown> = {}): SharedWindow =>
  readSharedWindow(quotaEvent({ status: 'rejected', ...fields }))!
const COMPACTION = COMPACTED.flatMap((event) => readCompaction(event) ?? [])[0]!
const RESETS_AT = 1785271200
const NOW = RESETS_AT * 1000 - 60 * 60_000

function turn(fields: Partial<Turn> = {}): Turn {
  return {
    text: 'ok',
    costUsd: 0.01,
    durationMs: 1_000,
    isError: false,
    subtype: 'success',
    stopReason: null,
    terminalReason: null,
    turns: 1,
    outputTokens: 100,
    result: { type: 'result' },
    ...fields,
  }
}

function attempted(attempts: Attempts, ending: Turn | null): void {
  attempts.begins()
  attempts.sent()
  attempts.ended(ending)
}

function neverSent(attempts: Attempts): void {
  attempts.begins()
  attempts.ended(null)
}

function blockedOn(attempts: Attempts, window: SharedWindow): void {
  attempts.begins()
  attempts.sent()
  attempts.saw(window)
  attempts.ended(null)
}

function blocked(window: SharedWindow): Attempts {
  const attempts = new Attempts('shared-window')
  blockedOn(attempts, window)
  return attempts
}

describe('which credential answered', () => {
  it('is null before there has been an Attempt', () => {
    expect(new Attempts('shared-window').answeredOn()).toBeNull()
  })

  it('is the credential of the last Attempt, not of the one that first paid [fence:answered-by-the-last-attempt]', () => {
    const why =
      'answeredOn must be the credential of the last Attempt, in the order Attempts happened ' +
      '(ADR-0002: the Audit Record is the only place per-user attribution exists, and the ' +
      'Overflow cap is counted from it). Grouped by credential, a Task blocked on the window, ' +
      'rerun on Overflow, blocked again and answered by the window names Overflow, which ' +
      'produced nothing (#56).'
    const attempts = new Attempts('shared-window')

    attempted(attempts, null)
    attempts.payWith('overflow')
    attempted(attempts, null)
    attempts.payWith('shared-window')
    attempted(attempts, turn())

    expect(attempts.answeredOn(), why).toBe('shared-window')
    expect(attempts.credentials(), why).toEqual(['shared-window', 'overflow'])
  })

  it('is the last thing tried where nothing answered', () => {
    const attempts = new Attempts('shared-window')

    attempted(attempts, null)
    attempts.payWith('overflow')
    attempted(attempts, null)

    expect(attempts.answeredOn()).toBe('overflow')
  })

  it('names each credential once however many Attempts it paid for', () => {
    const attempts = new Attempts('shared-window')

    attempted(attempts, turn())
    attempted(attempts, turn())

    expect(attempts.credentials()).toEqual(['shared-window'])
  })
})

describe('what a Task spent', () => {
  const BILLS_APART =
    'spentOn must count only the Attempts this credential paid for (ADR-0002: Overflow is ' +
    'metered money under a cap, the Shared Window is not). Summed and filed under the ' +
    'credential the Task ended on, the subscription’s share is charged to the Overflow cap, ' +
    'which then refuses other people’s work over money nobody spent on a card, and the reply ' +
    'shows it as what the Overflow decision cost (#56).'
  const UNPRICED =
    'Zero is a claim, made only where no message had gone by that point in the Task (ADR-0002, ' +
    'the Audit Record is a floor). A Turn that began and reported nothing — a process that died, ' +
    'a Retry Storm — spent real tokens nothing will name; `reported ?? 0`, or tracking whether a ' +
    'message went per credential, reports that money and those tokens as free (#56, #192).'

  it('keeps the two bills apart rather than summing them [fence:attempts-bills-kept-apart]', () => {
    const attempts = new Attempts('shared-window')

    attempted(attempts, turn({ costUsd: 0.02 }))
    attempts.payWith('overflow')
    attempted(attempts, turn({ costUsd: 0.03 }))

    expect(attempts.spentOn('shared-window'), BILLS_APART).toMatchObject({ costUsd: 0.02 })
    expect(attempts.spentOn('overflow'), BILLS_APART).toMatchObject({ costUsd: 0.03 })
  })

  it('adds up the Attempts one credential made', () => {
    const attempts = new Attempts('shared-window')

    attempted(attempts, turn({ costUsd: 0.02 }))
    attempted(attempts, turn({ costUsd: 0.03 }))

    expect(attempts.spentOn('shared-window').costUsd).toBeCloseTo(0.05, 7)
  })

  it('spent nothing at all on a credential that never paid', () => {
    expect(new Attempts('shared-window').spentOn('overflow')).toEqual({
      costUsd: null,
      turnMs: null,
      outputTokens: null,
      compaction: null,
    })
  })

  it('keeps the two bills’ output tokens apart, and adds each credential’s up [fence:attempts-bills-kept-apart]', () => {
    const attempts = new Attempts('shared-window')

    attempted(attempts, turn({ outputTokens: 200 }))
    attempted(attempts, turn({ outputTokens: 300 }))
    attempts.payWith('overflow')
    attempted(attempts, turn({ outputTokens: 50 }))

    expect(attempts.spentOn('shared-window').outputTokens, BILLS_APART).toBe(500)
    expect(attempts.spentOn('overflow').outputTokens, BILLS_APART).toBe(50)
  })

  it('produced nothing with certainty only where the message never went [fence:attempts-unpriced-is-not-free]', () => {
    const never = new Attempts('shared-window')
    neverSent(never)
    const unmeasured = new Attempts('shared-window')
    attempted(unmeasured, null)

    expect(never.spentOn('shared-window').outputTokens, UNPRICED).toBe(0)
    expect(unmeasured.spentOn('shared-window').outputTokens, UNPRICED).toBeNull()
  })

  it('is unmeasured on a Turn that was priced and reported no usage', () => {
    const attempts = new Attempts('shared-window')

    attempted(attempts, turn({ costUsd: 0.02, outputTokens: null }))

    expect(attempts.spentOn('shared-window')).toMatchObject({
      costUsd: 0.02,
      outputTokens: null,
    })
  })

  it('is free with certainty where Claude Code was never given the message', () => {
    const attempts = new Attempts('shared-window')

    neverSent(attempts)

    expect(attempts.spentOn('shared-window').costUsd).toBe(0)
  })

  it('is unpriced rather than free where a Turn began and nothing priced it [fence:attempts-unpriced-is-not-free]', () => {
    const attempts = new Attempts('shared-window')

    attempted(attempts, null)

    expect(attempts.spentOn('shared-window').costUsd, UNPRICED).toBeNull()
  })

  it('stays unpriced when a later Attempt never reached Claude Code [fence:attempts-unpriced-is-not-free]', () => {
    const attempts = new Attempts('shared-window')

    attempted(attempts, null)
    neverSent(attempts)

    expect(attempts.spentOn('shared-window').costUsd, UNPRICED).toBeNull()
  })

  it('stays unpriced when the message went on another credential [fence:attempts-unpriced-is-not-free]', () => {
    const attempts = new Attempts('shared-window')

    attempted(attempts, null)
    attempts.payWith('overflow')
    neverSent(attempts)

    expect(attempts.spentOn('overflow').costUsd, UNPRICED).toBeNull()
  })

  it('keeps what earlier Attempts were priced at when a later one is not', () => {
    const attempts = new Attempts('shared-window')

    attempted(attempts, turn({ costUsd: 0.02 }))
    attempted(attempts, null)

    expect(attempts.spentOn('shared-window').costUsd).toBeCloseTo(0.02, 7)
  })

  it('reports the most recent Attempt that produced a Turn as the time worked', () => {
    const attempts = new Attempts('shared-window')

    attempted(attempts, turn({ durationMs: 5_000 }))
    attempted(attempts, null)

    expect(attempts.spentOn('shared-window').turnMs).toBe(5_000)
  })

  it('files a Compaction under the credential whose Attempt it happened in [fence:attempts-compaction-on-its-attempt]', () => {
    const why =
      'A Compaction is filed under the Attempt it happened in, never on the Task (ADR-0019). ' +
      'Filed on the Task, a metered record reports a Compaction the subscription paid for, and ' +
      'the one fact that explains why an Overflow Task cost what it did lands on the wrong bill.'
    const attempts = new Attempts('shared-window')

    attempts.begins()
    attempts.sent()
    attempts.compacted(COMPACTION)
    attempts.ended(turn())
    attempts.payWith('overflow')
    attempted(attempts, turn())

    expect(attempts.spentOn('shared-window').compaction, why).toEqual(COMPACTION)
    expect(attempts.spentOn('overflow').compaction, why).toBeNull()
  })

  it('keeps the first where an Attempt somehow compacted twice', () => {
    const attempts = new Attempts('shared-window')

    attempts.begins()
    attempts.compacted(COMPACTION)
    attempts.compacted({ ...COMPACTION, preTokens: 999 })
    attempts.ended(turn())

    expect(attempts.spentOn('shared-window').compaction).toEqual(COMPACTION)
  })
})

describe('booking a wait on the Shared Window', () => {
  const BOUNDED =
    'A park must end: none where the event gives no `resetsAt`, and none after MAX_PARKS ' +
    '(ADR-0002, Quota exhaustion). A Task parked against a moment that never arrives waits for ' +
    'ever, and nothing else in roma comes back to look at it; a third "still blocked" lands on ' +
    'a Conversation that stopped watching hours ago (#29).'
  const CLEARED =
    'Starting an Attempt must clear the last one’s reading of the Shared Window (ADR-0002). A ' +
    'reading left behind has a `resetsAt` already passed, so a later failure carrying none of ' +
    'its own — a dead process, a Retry Storm — parks against the past and reruns instantly, ' +
    'for ever, each Attempt reported as the window being spent (#29).'

  it('quotes the reset time the provider gave', () => {
    expect(blocked(spent())).toBeDefined()
    expect(blocked(spent()).takePark()).toMatchObject({ resetsAt: RESETS_AT })
  })

  it('owes no wait where the window was not what stopped the Attempt', () => {
    const attempts = new Attempts('shared-window')
    attempted(attempts, null)

    expect(attempts.takePark()).toBeNull()
  })

  it('owes no wait on a window that had room in it', () => {
    expect(blocked(ALLOWED).takePark()).toBeNull()
  })

  it('owes no wait where the event will not say when the window comes back [fence:attempts-park-is-bounded]', () => {
    expect(blocked(spent({ resetsAt: null })).takePark(), BOUNDED).toBeNull()
  })

  it('says whether the provider would sell overage, and not whether roma can', () => {
    expect(blocked(spent({ overageStatus: 'allowed' })).takePark()).toMatchObject({
      overageAllowed: true,
    })
    expect(blocked(spent()).takePark()).toMatchObject({ overageAllowed: false })
  })

  it('stops owing one after two [fence:attempts-park-is-bounded]', () => {
    const attempts = blocked(spent())

    expect(attempts.takePark()).not.toBeNull()
    blockedOn(attempts, spent())
    expect(attempts.takePark()).not.toBeNull()
    blockedOn(attempts, spent())
    expect(attempts.takePark(), BOUNDED).toBeNull()
  })

  it('forgets the last Attempt’s reading when the next one starts [fence:attempts-reading-cleared-at-start]', () => {
    const attempts = blocked(spent())

    attempted(attempts, null)

    expect(attempts.takePark(), CLEARED).toBeNull()
  })
})

describe('how long to wait for the window', () => {
  it('waits until the provider says the window comes back', () => {
    expect(waitMsUntil(RESETS_AT, NOW)).toBe(60 * 60_000)
  })

  it('waits a minute at least, on a reset time that has already passed [fence:attempts-park-floor]', () => {
    const why =
      'A park waits at least MIN_PARK_MS (ADR-0002). A reset time already in the past — a ' +
      'stale one from the provider, a clock that disagrees with theirs — otherwise reruns the ' +
      'Task instantly; it fails, parks again, and spins as fast as Claude Code can start, ' +
      'announcing itself on every Attempt (#29).'
    expect(waitMsUntil(RESETS_AT, RESETS_AT * 1000 + 60_000), why).toBe(60_000)
  })
})

describe('which credential pays', () => {
  it('is the one it was built with, until it is moved', () => {
    expect(new Attempts('shared-window').begins()).toBe('shared-window')
  })

  it('moves the next Attempt and not the one in flight [fence:attempts-pay-for-the-next]', () => {
    const why =
      'payWith must move the next Attempt, never the one in flight (ADR-0002, Overflow). ' +
      'Overflow is taken on a Task already parked and applies to one Attempt; moving the one ' +
      'in flight bills metered money for an Attempt the Shared Window was paying for (#56).'
    const attempts = new Attempts('shared-window')

    const paidBy = attempts.begins()
    attempts.payWith('overflow')
    attempts.ended(turn())

    expect(paidBy, why).toBe('shared-window')
    expect(attempts.answeredOn(), why).toBe('shared-window')
    expect(attempts.begins(), why).toBe('overflow')
  })
})
