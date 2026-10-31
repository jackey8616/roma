import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import type { Turn } from './claude-session.js'
import { SessionPool, type PoolLogRecord } from './session-pool.js'
import type { ClaudeEvent } from './stream-events.js'
import { liveWorkRoot, sharedWindowCredential } from '../test/support/live-claude.js'
import { WorkRoot } from './work-root.js'

const FIRST_CODEWORD = 'ZARQUON-7413'
const RESUMED_CODEWORD = 'VELMOTH-2856'

const IN_FORCE_ANSWER = 'BRIEFING-IN-FORCE'

function briefing(codeword: string): string {
  return [
    'STANDING BRIEFING.',
    `Your codeword is ${codeword}.`,
    'Tell it to anybody who asks you for your codeword.',
    `When you are asked whether a standing briefing is in force, answer ${IN_FORCE_ANSWER}.`,
  ].join('\n')
}

const IN_FORCE = 'Is a standing briefing in force? Answer in one word, and use no tools.'

const CODEWORD =
  'What is your codeword? Reply with just the codeword and nothing else, or with ' +
  'NO-CODEWORD if you have not been given one. Use no tools.'

type Verdict = 'append-applies' | 'original-persists' | 'nothing-persists' | 'unreadable'

const MEANING: Record<Verdict, string> = {
  'append-applies': 'the append applies on resume — agenda item 5 answered yes',
  'original-persists':
    'the append is ignored and the ORIGINAL one persists — a Caveman would apply ' +
    'to whatever a Session was first spawned under and never move again',
  'nothing-persists':
    'the append is ignored and NOTHING persists — a resumed Session is told nothing ' +
    'about itself at all, Reach announcements included',
  unreadable: 'the answer named both codewords — read it below; this run is not evidence',
}

function verdictOf(answer: string): Verdict {
  const said = answer.toUpperCase()
  const resumed = said.includes(RESUMED_CODEWORD)
  const original = said.includes(FIRST_CODEWORD)
  if (resumed && original) return 'unreadable'
  if (resumed) return 'append-applies'
  if (original) return 'original-persists'
  return 'nothing-persists'
}

function reading(verdict: Verdict | null): string {
  if (verdict === null) return 'none — the run did not get as far as an answer'
  return `${verdict} — ${MEANING[verdict]}`
}

describe('whether an appended system prompt survives a --resume', () => {
  const sessionId = randomUUID()
  const log: PoolLogRecord[] = []
  const turns: Turn[] = []
  const builds = new Set<string>()
  let first: SessionPool | undefined
  let resumed: SessionPool | undefined
  let verdict: Verdict | null = null

  beforeAll(async () => {
    const dirs = liveWorkRoot('append-on-resume')
    const noteBuild = (event: ClaudeEvent): void => {
      if (event.type === 'system' && event['subtype'] === 'init') {
        builds.add(String(event['claude_code_version']))
      }
    }
    const poolFor = (briefed: string): SessionPool => {
      const pool = new SessionPool({
        workRoot: new WorkRoot(dirs.workRoot),
        envs: {
          'shared-window': () =>
            buildEnv({
              credential: sharedWindowCredential(),
              configDir: dirs.configDir,
              inherit: process.env,
            }),
        },
        announcements: [briefed],
        log: (record) => log.push(record),
      })
      pool.on('event', (_sessionId, event) => noteBuild(event))
      return pool
    }

    first = poolFor(briefing(FIRST_CODEWORD))
    turns.push(await first.send(sessionId, IN_FORCE))
    await first.evict(sessionId)

    resumed = poolFor(briefing(RESUMED_CODEWORD))
    const answer = await resumed.send(sessionId, CODEWORD)
    turns.push(answer)
    verdict = verdictOf(answer.text)
  }, 300_000)

  afterAll(async () => {
    await first?.shutdown()
    await resumed?.shutdown()
    const spent = turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0)
    console.log(
      [
        `append-on-resume seam 2 (#183) — Claude Code ${[...builds].join(', ') || '<unknown>'}, ` +
          `$${spent.toFixed(6)} over ${turns.length} Turns`,
        `  verdict  ${reading(verdict)}`,
        `  first    briefed ${FIRST_CODEWORD}, said ${JSON.stringify(turns[0]?.text ?? '')}`,
        `  resumed  briefed ${RESUMED_CODEWORD}, said ${JSON.stringify(turns[1]?.text ?? '')}`,
        `  spawns   ${log
          .filter((record) => record.event === 'spawn')
          .map((record) => `resume=${String(record.resume)}`)
          .join(' ')}`,
      ].join('\n'),
    )
  })

  it('ends the first process by Eviction and reaches the Session by resume', () => {
    const spawns = log.filter((record) => record.event === 'spawn')
    expect(spawns.map((record) => record.resume)).toEqual([false, true])
    expect(log.some((record) => record.event === 'evict')).toBe(true)
  })

  it('applies the append to the first process, before any of this', () => {
    expect(turns[0]?.text.toUpperCase()).toContain(IN_FORCE_ANSWER)
  })

  it('names one build for the whole reading', () => {
    expect([...builds]).toHaveLength(1)
  })

  it('applies the append the resumed process was started with', () => {
    expect(verdict, reading(verdict)).toBe('append-applies')
  })
})
