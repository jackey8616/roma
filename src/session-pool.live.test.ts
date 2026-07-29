import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import type { Turn } from './claude-session.js'
import { SessionPool, type PoolLogRecord } from './session-pool.js'
import { liveWorkRoot, sharedWindowCredential } from '../test/support/live-claude.js'

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
      workRoot: dirs.workRoot,
      envs: {
        'shared-window': buildEnv({
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

  // The trap #4 walks into first, settled here. If `total_cost_usd` carried
  // forward from the transcript, the first Turn after every eviction would be
  // recorded at the price of the whole Session so far — the exact failure the
  // per-Turn delta exists to prevent, arriving at the point where eviction makes
  // resume routine rather than rare.
  //
  // It does not carry forward: the total is cumulative for the *process*, so a
  // resumed one starts again from zero and the cost baseline never has to cross
  // an eviction. First measured here on v2.1.220, $0.0822846 before the eviction
  // and $0.0105342 after it.
  //
  // Asserted rather than merely reported, because the whole cost model rests on
  // it: a Claude Code version that changed this would silently start billing
  // every post-eviction Turn at the Session's lifetime spend, and this is the
  // only place that can go red instead.
  it("counts the resumed process's cost from zero rather than carrying it forward", () => {
    const beforeUsd = Number(turns[1]?.result['total_cost_usd'])
    const resumed = turns[2]
    const afterUsd = Number(resumed?.result['total_cost_usd'])

    console.log(`seam 2: total_cost_usd ${beforeUsd} before the eviction, ${afterUsd} after it`)

    // This is the assertion that reads the CLI rather than roma: a total that
    // had carried forward could only have grown, so a smaller one after the
    // resume means the new process is counting its own spend.
    expect(afterUsd).toBeGreaterThan(0)
    expect(afterUsd).toBeLessThan(beforeUsd)
    // And this is what that buys — the Turn's own figure, with no baseline
    // carried across the eviction to subtract.
    expect(resumed?.costUsd).toBeCloseTo(afterUsd, 9)
  })
})
