import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import { ClaudeSession, type Turn } from './claude-session.js'
import type { ClaudeEvent } from './stream-events.js'
import { liveSessionDirs, sharedWindowCredential } from '../test/support/live-claude.js'

// SEAM 2 — a real `claude -p`. Slow, and it spends Shared Window quota.
// Excluded from `npm test` by living in its own config; run it with
// `npm run test:seam2`.
//
// #98's step one, and the reason that issue is `ready-for-human`: everything the
// issue decides about Compaction rests on one fact nobody had measured, which is
// whether `system/compact_boundary` reaches roma's **stdout** at all rather than
// only the Transcript. Claude Code's own parser for the event reads transcript
// files, so the shape was certain and the delivery was not — and this repository
// does not build on likely. ADR-0003 exists because a documented property of
// `--output-format stream-json` turned out to be wrong in a way that cost a
// prototype.
//
// What the run found is in `docs/compaction-verification.md`, where a
// measurement of a specific build belongs. It is not restated here: this file's
// job is to produce the reading, and prose that repeats a result goes stale the
// first time somebody runs it against a newer pin without touching the comment.

/**
 * The lever that makes this measurement cost cents rather than a fortune.
 *
 * #98 laid out a ladder of three ways to provoke a Compaction without filling a
 * real context window, and this is a fourth that beats all of them. The pinned
 * bundle reads it straight off `process.env`:
 *
 *     testPctOverride; if (n !== undefined && !isNaN(n) && n > 0 && n <= 100)
 *       return Math.min(Math.floor(e * (n / 100)), r); return r
 *
 * `e` is the context window, so the auto-compact threshold becomes a percentage
 * of it. Three properties earn it the job over the issue's own rungs. There is
 * no feature gate — the issue's rung 1 (`/autocompact` over stdin) is fenced
 * behind `p2d()`, which resolves to a remote experiment flag and may simply be
 * off for an account. There is no model guard, unlike its neighbour
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, which the same bundle ignores for any model
 * whose name begins `claude-` — every model roma runs. And `Math.min` means it
 * can only ever *lower* the threshold, so a typo cannot produce a Session that
 * quietly never compacts.
 *
 * It is also an environment variable, which is the surface `buildEnv` already
 * owns. The issue's rung 2 was explicitly *not* a settings file, for a good
 * reason — a setting Claude Code ignores is "a measurement that looks like it
 * ran". This is not that: it is read from the environment on every call.
 */
const PCT_OVERRIDE = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'

/**
 * What a Session's context holds before anybody has said anything, measured.
 *
 * `/context` on a freshly spawned roma-shaped Session reports 29.9k of a 967k
 * window — 8.9k of system prompt, 17.4k of tool schemas, and the rest memory
 * files and skills. It costs nothing to ask, because `/context` is a Readout.
 *
 * The number is here because it is what makes the two percentages below
 * different measurements rather than two guesses. A threshold *above* it is one
 * a conversation can grow into; a threshold *below* it is one the conversation
 * can never be reduced under, because a system prompt is not conversation and no
 * Compaction can summarise it away.
 */
const BASELINE_TOKENS = 29_900

/** Threshold ≈ 40k against a 967k window: above the baseline, one filler Turn away. */
const ROOM_TO_GROW = '4'

/** Threshold ≈ 10k: below the baseline, so no Compaction can succeed. */
const BELOW_THE_FLOOR = '1'

/**
 * Roughly 14k tokens of prose, to be spent in one Turn.
 *
 * Varied rather than one word repeated, so it tokenises like text; generated
 * rather than committed, because a fixture in the repository is one more thing
 * to keep and this exists only to take up room.
 */
function filler(): string {
  const words = [
    'ledger',
    'window',
    'session',
    'compaction',
    'threshold',
    'operator',
    'caller',
    'audit',
    'transcript',
    'generation',
    'enclosure',
    'readout',
  ]
  return Array.from({ length: 900 }, (_, i) => {
    const line = Array.from({ length: 10 }, (_, j) => words[(i * 7 + j * 3) % words.length])
    return `filler-${String(i).padStart(4, '0')}: ${line.join(' ')}`
  }).join('\n')
}

/** The reply asked for everywhere here: as few output tokens as a Turn can have. */
const OK = 'Reply with the single word OK. Do not use any tools.'

interface Probe {
  readonly session: ClaudeSession
  /** Every event this Session put on stdout, in order. */
  readonly events: ClaudeEvent[]
  /**
   * Send one message and keep the events that arrived while it was in flight.
   *
   * A slice rather than another listener, and it is exact: `send` resolves only
   * after the terminal `result` has been emitted to `event` listeners, so
   * everything appended since the call belongs to this Turn.
   *
   * Which Turn a Compaction lands in is Claude Code's decision and not this
   * test's, so a test that hard-coded "the third one" would go red on a build
   * that accounted tokens slightly differently — and would say the cost claim
   * had failed when all that moved was the timing.
   */
  say(text: string): Promise<{ turn: Turn; events: ClaudeEvent[] }>
}

function probe(name: string, pct: string): Probe {
  const { configDir, cwd } = liveSessionDirs(name)
  const session = new ClaudeSession({
    sessionId: randomUUID(),
    cwd,
    env: {
      ...buildEnv({ credential: sharedWindowCredential(), configDir, inherit: process.env }),
      // Added here rather than in `buildEnv` on purpose. `buildEnv`'s rule is
      // that it admits almost nothing, and this belongs to a probe rather than
      // to roma — nothing roma ships sets it, and a Session that did would have
      // its context thrown away early for no reason anybody could see.
      [PCT_OVERRIDE]: pct,
    },
  })
  const events: ClaudeEvent[] = []
  session.on('event', (event) => events.push(event))
  return {
    session,
    events,
    async say(text) {
      const from = events.length
      const turn = await session.send(text)
      return { turn, events: events.slice(from) }
    },
  }
}

/** The `system/compact_boundary` events a run put on stdout. */
function boundaries(events: readonly ClaudeEvent[]): ClaudeEvent[] {
  return events.filter((e) => e.type === 'system' && e['subtype'] === 'compact_boundary')
}

/**
 * The events reporting a Compaction that did not work.
 *
 * Located by the *field* rather than by the subtype, which is the finding: the
 * failure does not arrive as a `compact_boundary` at all. It rides on a
 * `system/status`, an event that also carries ordinary progress, so the only
 * thing that marks one is `compact_result`.
 */
function compactResults(events: readonly ClaudeEvent[]): ClaudeEvent[] {
  return events.filter((e) => 'compact_result' in e)
}

describe('a Compaction on the Session stdout roma reads', () => {
  it('announces itself, with what it cost and what it dropped', async () => {
    const { session, events, say } = probe('compaction', ROOM_TO_GROW)

    try {
      session.start()

      // Free, and load-bearing. It pins the run's own starting point rather than
      // trusting the constant above, so a build that arrives with a bigger system
      // prompt fails here — naming the reason — instead of further down as a
      // Compaction that never fired.
      const { turn: before } = await say('/context')
      expect(before.turns).toBe(0)

      // One Turn of bulk, then two identical trivial ones. The pair is the whole
      // point: they are the same message, so any difference between them belongs
      // to something that happened rather than to what was asked.
      await say(`${filler()}\n\n${OK}`)
      const pair = [await say(OK), await say(OK)]

      const [boundary] = boundaries(events)
      expect(boundary, 'no system/compact_boundary reached stdout').toBeDefined()

      // The shape roma will read, asserted as it arrives on the wire. Claude
      // Code's own parser for this event — the one #98 quotes — reads
      // `compactMetadata.preservedSegment`, and that is the **Transcript's**
      // spelling. What comes down stdout is snake_case and nested under
      // `compact_metadata`, so a reader built from the quoted parser finds
      // `undefined` and reports every Compaction as no Compaction.
      const metadata = boundary?.['compact_metadata'] as Record<string, unknown>
      expect(metadata).toBeDefined()
      expect(metadata['trigger']).toBe('auto')
      expect(typeof metadata['pre_tokens']).toBe('number')
      expect(Number(metadata['pre_tokens'])).toBeGreaterThan(BASELINE_TOKENS)

      // The claim #98 is actually built on, and the one nobody had shown: the
      // money lands on whoever sent the message that crossed the threshold. Two
      // byte-identical messages, and the one the Compaction happened inside of
      // drove an extra Turn and cost several times the other.
      //
      // Which of the pair that is gets looked up rather than assumed — see
      // `say`. If it were neither, the Compaction landed in the filler Turn,
      // where a cost difference proves nothing because the messages differ.
      const carrying = pair.find((sent) => boundaries(sent.events).length > 0)
      const quiet = pair.find((sent) => boundaries(sent.events).length === 0)
      expect(carrying, 'the Compaction landed outside the identical pair').toBeDefined()
      expect(quiet, 'both of the identical pair carried a Compaction').toBeDefined()

      expect(Number(carrying?.turn.turns)).toBeGreaterThan(Number(quiet?.turn.turns))
      expect(Number(carrying?.turn.costUsd)).toBeGreaterThan(Number(quiet?.turn.costUsd))

      console.log(
        `seam 2: compact_boundary on stdout — ${JSON.stringify(metadata)}; ` +
          `of two identical messages the quiet one cost ${String(quiet?.turn.costUsd)} ` +
          `over ${String(quiet?.turn.turns)} turn(s) in ${String(quiet?.turn.durationMs)}ms, ` +
          `the one carrying the Compaction ${String(carrying?.turn.costUsd)} over ` +
          `${String(carrying?.turn.turns)} in ${String(carrying?.turn.durationMs)}ms`,
      )
    } finally {
      await session.terminateOrKill()
    }
  })

  it('says so on the same stdout when it fails', async () => {
    const { session, events, say } = probe('compaction-failed', BELOW_THE_FLOOR)

    try {
      session.start()
      // No filler. The threshold is already under the floor, so the first Turn
      // is enough — and a Session that cannot compact is exactly the state under
      // test, so nothing here may depend on a Turn succeeding.
      await say(OK)
      const { turn: after } = await say(OK)

      const [failure] = compactResults(events).filter((e) => e['compact_result'] === 'failed')
      expect(failure, 'no compact_result reached stdout').toBeDefined()
      expect(failure?.['compact_result']).toBe('failed')

      // A code, not a sentence. #98 rejected matching on the failure's error
      // *text* — "defining behaviour by one build's strings, which is the mistake
      // `shared-window.ts` already made once" — and this is the field that makes
      // that rejection cost nothing.
      expect(typeof failure?.['compact_error']).toBe('string')

      // The correction this test exists to keep true. #98's design assumes a
      // failed Compaction leaves "a Session that cannot serve another Turn".
      // This one served the next Turn normally. Whether *every* failure is
      // survivable is not settled by one of them — see the verification document
      // — but "failed therefore dead" is now known to be too strong.
      expect(after.isError).toBe(false)

      console.log(
        `seam 2: compact_result=${String(failure?.['compact_result'])} ` +
          `compact_error=${String(failure?.['compact_error'])} ` +
          `on ${String(failure?.type)}/${String(failure?.['subtype'])}; ` +
          `the Session then served a Turn at ${String(after.costUsd)}`,
      )
    } finally {
      await session.terminateOrKill()
    }
  })
})
