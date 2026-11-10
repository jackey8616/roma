import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { relayed } from './attribution.js'
import { buildEnv } from './build-env.js'
import { ClaudeSession, type Turn } from './claude-session.js'
import { readRelay, relaySpellings } from './relays.js'
import { liveSessionDirs, sharedWindowCredential } from '../test/support/live-claude.js'

const CALLER = { caller: 'users/17', callerName: 'Ada' }

const CHAT = [
  'Reply with the single word ALPHA. Do not use any tools.',
  'Reply with the single word BRAVO. Do not use any tools.',
  'Reply with the single word CHARLIE. Do not use any tools.',
]

const KEEP = 'Keep the three words that were said and nothing else.'

describe('what each entry on the Relay list costs', () => {
  const turns = new Map<string, Turn>()
  let session: ClaudeSession

  beforeAll(async () => {
    const { configDir, cwd } = liveSessionDirs('relay-cost-class')
    session = new ClaudeSession({
      sessionId: randomUUID(),
      cwd,
      env: buildEnv({ credential: sharedWindowCredential(), configDir, inherit: process.env }),
    })
    session.start()

    for (const spelling of relaySpellings()) {
      const relay = readRelay(spelling)
      if (relay === null || relay.cost !== 'free') continue
      turns.set(spelling, await session.send(relayed(CALLER, relay)))
    }

    for (const message of CHAT) await session.send(message)

    for (const spelling of relaySpellings()) {
      const relay = readRelay(`${spelling} ${KEEP}`)
      if (relay === null || relay.cost !== 'paid') continue
      turns.set(spelling, await session.send(relayed(CALLER, relay)))
    }
  }, 300_000)

  afterAll(async () => {
    if (session.alive) await session.terminate()
    console.log(
      [
        `relay cost class seam 2 — $${session.cumulativeCostUsd.toFixed(6)} over ${turns.size} entries`,
        ...[...turns].map(
          ([spelling, turn]) =>
            `  ${spelling.padEnd(10)} num_turns=${String(turn.turns)} ` +
            `out=${String(turn.outputTokens)} delta=${String(turn.costUsd)}`,
        ),
      ].join('\n'),
    )
  })

  it('sends every entry on the list', () => {
    expect([...turns.keys()].sort()).toEqual([...relaySpellings()].sort())
  })

  it.each(relaySpellings())('%s costs what the list says it does', (spelling) => {
    const cost = readRelay(spelling)?.cost
    const turn = turns.get(spelling)
    if (turn === undefined) throw new Error(`nothing was sent for ${spelling}`)

    if (cost === 'free') {
      expect(turn.outputTokens).toBe(0)
      expect(turn.costUsd).toBe(0)
      expect(turn.text).not.toBe('')
      expect(turn.text).not.toContain('Unknown command')
      return
    }

    expect(turn.outputTokens ?? 0).toBeGreaterThan(0)
    expect(turn.costUsd ?? 0).toBeGreaterThan(0)
  })

  it('returns no text at all from a Compaction that worked', () => {
    const compact = turns.get('/compact')
    expect(compact?.text).toBe('')
  })
})
