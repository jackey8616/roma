import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { relayed } from './attribution.js'
import { buildEnv } from './build-env.js'
import { ClaudeSession, type Turn } from './claude-session.js'
import { readRelay, relaySpellings } from './relays.js'
import { liveSessionDirs, sharedWindowCredential } from '../test/support/live-claude.js'

// SEAM 2 — a real `claude -p`. Slow, and it spends Shared Window quota.
// Excluded from `npm test` by living in its own config. Run this file on its
// own — `npm run test:seam2` includes every `*.live.test.ts` in the repository:
//
//     npx vitest run --config vitest.seam2.config.ts src/relays.live.test.ts
//
// **The check that fires before the money moves.** `src/relays.ts` declares what
// each entry costs, and that declaration is a person's judgement about one build
// (ADR-0007's pin). The Core's drift check catches a free entry that has started
// doing model work — after somebody has been billed for it, in production. This
// catches the same thing on the way in, which is the half ADR-0014 used for the
// Model Menu and #85 asked for.
//
// Neither replaces the other, and ADR-0018 says why: `/autocompact`'s own gate
// is a remote experiment flag, so Claude Code's behaviour can move under a
// *fixed* binary. A pin-move ritual alone assumes the binary is the whole
// contract, and it is not.
//
// One case per entry, from the real table — a list this iterated by hand would
// go on passing when somebody added a sixth string to `relays.ts` and forgot
// this file.
//
// **One Session for all of it**, and the order is deliberate. The free entries
// go first on a process that has spent nothing, then a short conversation, then
// the paid one — which needs conversation to summarise, and which would fail
// with "Not enough messages to compact." on an empty Session and pass a check
// that only looked at the cost.

const CALLER = { caller: 'users/17', callerName: 'Ada' }

/** As few output tokens as a Turn can have, so the setup is not what is measured. */
const CHAT = [
  'Reply with the single word ALPHA. Do not use any tools.',
  'Reply with the single word BRAVO. Do not use any tools.',
  'Reply with the single word CHARLIE. Do not use any tools.',
]

/**
 * What the paid entry is asked to keep.
 *
 * Sent through `relayed` like everything else here, so what goes on the wire is
 * the frame roma actually writes — no Caller Marker, which is ADR-0018's one
 * exception and the thing most worth having on a real wire rather than only in a
 * unit test.
 */
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

    // Every free entry first, on a process with nothing behind it.
    for (const spelling of relaySpellings()) {
      const relay = readRelay(spelling)
      if (relay === null || relay.cost !== 'free') continue
      turns.set(spelling, await session.send(relayed(CALLER, relay)))
    }

    // Something to summarise. What limits a manual Compaction is the number of
    // conversation groups rather than the number of tokens, so three one-word
    // Turns is the whole setup — this file spends cents, not a context window.
    for (const message of CHAT) await session.send(message)

    for (const spelling of relaySpellings()) {
      const relay = readRelay(`${spelling} ${KEEP}`)
      if (relay === null || relay.cost !== 'paid') continue
      turns.set(spelling, await session.send(relayed(CALLER, relay)))
    }
  }, 300_000)

  // In the hook, so a run that spent the money leaves the reading behind even
  // when an assertion is what failed.
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

  // The table is what is iterated, and this is what stops that being vacuous: an
  // entry nothing sent would leave a case that asserts about `undefined` and
  // reads as passing.
  it('sends every entry on the list', () => {
    expect([...turns.keys()].sort()).toEqual([...relaySpellings()].sort())
  })

  it.each(relaySpellings())('%s costs what the list says it does', (spelling) => {
    const cost = readRelay(spelling)?.cost
    const turn = turns.get(spelling)
    if (turn === undefined) throw new Error(`nothing was sent for ${spelling}`)

    // `num_turns` is asserted on neither branch, and its absence is the finding:
    // it is **0** for a paid `/compact` that spent five cents, exactly as it is
    // for the four free entries. Reading it here would be re-making the mistake
    // ADR-0012's drift check made.
    if (cost === 'free') {
      // Free means no model work, which is the membership rule's own word, and
      // costing nothing follows from it rather than the other way round.
      expect(turn.outputTokens).toBe(0)
      expect(turn.costUsd).toBe(0)
      // And still the command rather than the model's guess about it: an entry
      // a later build has removed answers `Unknown command: /x`, for nothing,
      // and would pass a check that only looked at the money.
      expect(turn.text).not.toBe('')
      expect(turn.text).not.toContain('Unknown command')
      return
    }

    // Paid means model work happened. Asserted as a floor rather than a figure —
    // what a summarisation costs depends on the conversation, and this one is
    // three words long.
    expect(turn.outputTokens ?? 0).toBeGreaterThan(0)
    expect(turn.costUsd ?? 0).toBeGreaterThan(0)
  })

  // The measured shape of a successful `/compact`, and the reason roma writes
  // the reply itself. Nothing on the wire tells the Caller anything.
  it('returns no text at all from a Compaction that worked', () => {
    const compact = turns.get('/compact')
    expect(compact?.text).toBe('')
  })
})
