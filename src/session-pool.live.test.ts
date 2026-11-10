import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import type { Turn } from './claude-session.js'
import { SessionPool, type PoolLogRecord } from './session-pool.js'
import { liveSpawn, liveWorkRoot, sharedWindowCredential } from '../test/support/live-claude.js'
import { WorkRoot } from './work-root.js'

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
      spawn: liveSpawn,
      log: (record) => log.push(record),
    })

    turns.push(await pool.send(sessionId, PING))
    turns.push(await pool.send(sessionId, RECALL))
    await pool.evict(sessionId)
    turns.push(await pool.send(sessionId, RECALL))
  })

  afterAll(async () => {
    await pool.shutdown()
  })

  it('resumes with its context intact after being evicted', () => {
    expect(turns[2]?.text).toContain('PING')
  })

  it('creates the Session once and reaches it by resume afterwards', () => {
    const spawns = log.filter((record) => record.event === 'spawn')
    expect(spawns.map((record) => record.resume)).toEqual([false, true])
  })

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
