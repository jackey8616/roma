import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import type { Turn } from './claude-session.js'
import { SessionPool, type PoolLogRecord } from './session-pool.js'
import { liveWorkRoot, sharedWindowCredential } from '../test/support/live-claude.js'
import { WorkRoot } from './work-root.js'

// SEAM 2 — the pool against a real `claude -p`. Slow, and it spends Shared
// Window quota. Excluded from `npm test`; run it with `npm run test:seam2`.
//
// Eviction is the pool's whole justification and it is only safe because a
// `--resume` afterwards recovers the Session. Everything below is one run of
// that: a Turn, a SIGTERM, and a Turn served by a process that did not exist
// when the first one was asked.

const PING = 'Reply with exactly the word PING and nothing else. Do not use any tools.'
const RECALL = 'What word did I ask you to reply with? Answer with just that word.'

describe('a Session that outlives its process', () => {
  const sessionId = randomUUID()
  const log: PoolLogRecord[] = []
  const turns: Turn[] = []
  let pool: SessionPool

  beforeAll(async () => {
    const dirs = liveWorkRoot('outlives-its-process')
    pool = new SessionPool({
      workRoot: new WorkRoot(dirs.workRoot),
      envs: {
        'shared-window': () =>
          buildEnv({
            credential: sharedWindowCredential(),
            configDir: dirs.configDir,
            inherit: process.env,
          }),
      },
      log: (record) => log.push(record),
    })

    // Two Turns before the eviction rather than one, so that what the Session
    // has spent is comfortably more than any single Turn. The cost assertion
    // below turns on a resumed process reporting a *smaller* total than the
    // Session already has, and one Turn's spend is too narrow a margin to read
    // that from.
    turns.push(await pool.send(sessionId, PING))
    turns.push(await pool.send(sessionId, RECALL))
    await pool.evict(sessionId)
    turns.push(await pool.send(sessionId, RECALL))
  })

  afterAll(async () => {
    await pool.shutdown()
  })

  // The claim eviction rests on. If context did not survive it, ten Resident
  // Sessions would have to be a hard limit on how many Conversations roma can
  // hold, rather than a limit on how many it keeps resident.
  it('resumes with its context intact after being evicted', () => {
    expect(turns[2]?.text).toContain('PING')
  })

  // Which is only meaningful if the second process really was a resume: the CLI
  // refuses `--session-id` and `--resume` together, so the pool has one chance
  // to pick correctly and no way to find out later that it picked wrong.
  it('creates the Session once and reaches it by resume afterwards', () => {
    const spawns = log.filter((record) => record.event === 'spawn')
    expect(spawns.map((record) => record.resume)).toEqual([false, true])
  })

  // The trap #4 walks into first. If the first Turn after an eviction were priced
  // off a total that carried forward from the Transcript, it would be recorded at
  // the price of the whole Session so far — at the point where eviction makes
  // resume routine rather than rare.
  //
  // 2.1.220 started a resumed process from zero ($0.0822846 before, $0.0105342
  // after). 2.1.319 carries the Transcript's total forward, so roma prices a Turn
  // off `model_usage_since_last_result` instead (ADR-0003, observability).
  //
  // Asserted on roma's figure, not on the CLI's total: what must hold is that
  // the Audit Record gets this Turn's own spend, whatever the CLI did with its
  // running total.
  it('prices the first Turn after an eviction at its own spend, not the Session’s', () => {
    const beforeUsd = Number(turns[1]?.result['total_cost_usd'])
    const resumed = turns[2]
    const afterUsd = Number(resumed?.result['total_cost_usd'])
    const own = resumed?.result['model_usage_since_last_result'] as
      Record<string, { costUSD?: number }> | undefined
    const ownUsd = Object.values(own ?? {}).reduce((sum, m) => sum + (m.costUSD ?? 0), 0)

    console.log(
      `seam 2: total_cost_usd ${beforeUsd} before the eviction, ${afterUsd} after it ` +
        `(${afterUsd > beforeUsd ? 'carried forward' : 'restarted'}); the Turn's own ${ownUsd}`,
    )

    expect(resumed?.costUsd).toBeGreaterThan(0)
    expect(resumed?.costUsd).toBeLessThan(beforeUsd)
    expect(resumed?.costUsd).toBeCloseTo(own === undefined ? afterUsd : ownUsd, 9)
  })
})
