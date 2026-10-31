import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import type { Turn } from './claude-session.js'
import { SessionPool, type PoolLogRecord } from './session-pool.js'
import { liveWorkRoot, sharedWindowCredential } from '../test/support/live-claude.js'
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

  it("counts the resumed process's cost from zero rather than carrying it forward", () => {
    const beforeUsd = Number(turns[1]?.result['total_cost_usd'])
    const resumed = turns[2]
    const afterUsd = Number(resumed?.result['total_cost_usd'])

    console.log(`seam 2: total_cost_usd ${beforeUsd} before the eviction, ${afterUsd} after it`)

    expect(afterUsd).toBeGreaterThan(0)
    expect(afterUsd).toBeLessThan(beforeUsd)
    expect(resumed?.costUsd).toBeCloseTo(afterUsd, 9)
  })
})
