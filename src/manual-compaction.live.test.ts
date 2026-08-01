import { randomUUID } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import { spawnClaudeProcess, type SpawnClaudeProcess } from './claude-process.js'
import { ClaudeSession, TurnFailedError, type Turn } from './claude-session.js'
import type { ClaudeEvent } from './stream-events.js'
import {
  liveCaptureFile,
  liveSessionDirs,
  sharedWindowCredential,
} from '../test/support/live-claude.js'

// SEAM 2 — a real `claude -p`. Slow, and it spends Shared Window quota.
// Excluded from `npm test` by living in its own config. Run this file on its
// own — `npm run test:seam2` includes every `*.live.test.ts` in the repository:
//
//     npx vitest run --config vitest.seam2.config.ts src/manual-compaction.live.test.ts
//
// ADR-0018's step one, and the line in its own verification section that asks
// for it: "Not verified — the manual path, in any respect." Every figure #98 and
// #100 produced is of an *auto* Compaction, and `trigger` is
// `E.enum(["manual","auto"])` — so half the enum had never been seen.
//
// roma has no code for a relayed `/compact` yet, so the frames below are written
// by hand, exactly as ADR-0012 relays a Readout and ADR-0018 decided a Relay
// carrying an argument would be written: command first, on stdin, as a
// `{type:'user'}` frame. When the implementation lands, these strings are what
// it has to produce.
//
// **`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is deliberately absent.** It is the lever
// `compaction.live.test.ts` leans on and it is the wrong one here: it lowers the
// *auto* threshold, and this file is about the path a person takes on purpose.
// Nothing here needs a full context window either — what decides whether a
// Compaction can run is the number of conversation groups, not the number of
// tokens, so a handful of one-word Turns is the whole setup.
//
// What the run found is in `docs/manual-compaction-verification.md`, where a
// measurement of a specific build belongs. It is not restated here: this file's
// job is to produce the reading, and prose that repeats a result goes stale the
// first time somebody runs it against a newer pin without touching the comment.

/**
 * The reply asked for in the setup Turns: as few output tokens as a Turn can
 * have, and a different word each time.
 *
 * Different rather than repeated because a conversation *group* opens at each
 * new assistant message, and three distinguishable answers make it obvious in a
 * capture where the boundaries are. It also gives the summariser something it
 * can be seen to have summarised.
 */
const CHAT = [
  'Reply with the single word ALPHA. Do not use any tools.',
  'Reply with the single word BRAVO. Do not use any tools.',
  'Reply with the single word CHARLIE. Do not use any tools.',
]

/** The bare Relay: roma's own literal string and nothing else. */
const COMPACT = '/compact'

/**
 * ADR-0018's frame, verbatim — command, blank line, Caller Marker, blank line,
 * the Caller's text.
 *
 * Quoted from the ADR rather than assembled, because the ADR is what decided the
 * ordering and this is the run that says whether the ordering survives contact
 * with the pinned build. ADR-0011's rule is the reason the marker moved back in
 * front of the Caller's text: what precedes it is roma's own string, and every
 * character the Caller typed follows it.
 */
const COMPACT_WITH_ARGUMENT = [
  '/compact',
  '',
  '<from>Ada (users/17)</from>',
  '',
  'keep the architecture decisions and anything still unresolved',
].join('\n')

/**
 * An ordinary short conversation, for the control below and for nothing else.
 *
 * `CHAT` cannot be used there, and finding that out cost a run. A thread whose
 * every message is "reply with the single word X" primes the model so hard that
 * the summariser — which is one more model call arriving in that same context —
 * reads Claude Code's own summarisation prompt as an injection and refuses it,
 * custom instructions and `<analysis>`/`<summary>` structure and all. A control
 * cannot distinguish "the argument was dropped" from "every instruction was
 * dropped", so it needs a conversation that is not fighting it.
 *
 * Two exchanges rather than three: measured as enough for the manual path, which
 * needs two groups with an assistant message among the ones being summarised.
 */
const DISCUSSION = [
  'Answer in one short sentence: what is a lockfile for?',
  'Answer in one short sentence: what is a git tag for?',
]

/**
 * A token that can only have got into a summary by travelling the whole way.
 *
 * The frame above is the one ADR-0018 decided, and it is the one that has to be
 * measured — but it cannot answer on its own whether the argument *arrived*. A
 * summariser handed "keep the architecture decisions and anything still
 * unresolved" and a four-message conversation would produce much the same
 * summary if the argument had been dropped on the floor, so a pass would prove
 * nothing. This is the control: same frame shape, same marker, an instruction
 * whose effect is unmistakable.
 */
const SENTINEL = 'COMPACT-ARG-7Q4J'

const COMPACT_WITH_SENTINEL = [
  '/compact',
  '',
  '<from>Ada (users/17)</from>',
  '',
  `Include the exact token ${SENTINEL} in the summary.`,
].join('\n')

/**
 * The same frame with roma's marker taken out, and nothing else changed.
 *
 * The control's own control. ADR-0018 records one accepted risk about the
 * marker — "it is roma's own tag wrapping a person's name, and a name inside a
 * summarisation instruction does not become another instruction" — and the only
 * way to hold that sentence to account is to run the argument both ways over the
 * same conversation and compare. Without this, anything the marked frame does
 * could equally be a fact about a short thread.
 */
const COMPACT_WITH_SENTINEL_UNMARKED = [
  '/compact',
  '',
  `Include the exact token ${SENTINEL} in the summary.`,
].join('\n')

/**
 * Spawn a real process and copy every byte of its stdout to a file on the way
 * past.
 *
 * Raw, and before anything parses it. A capture re-serialised from parsed events
 * is a capture somebody has to take on trust — it can only contain the fields
 * whoever wrote the reader already knew to look for, which is the opposite of
 * what a fixture is for.
 */
function teeing(to: string): SpawnClaudeProcess {
  return (request) => {
    const process = spawnClaudeProcess(request)
    const fd = openSync(to, 'a')
    process.onStdout((chunk) => writeSync(fd, chunk))
    process.onExit(() => closeSync(fd))
    return process
  }
}

interface Probe {
  readonly session: ClaudeSession
  /** Every event this Session put on stdout, in order. */
  readonly events: ClaudeEvent[]
  /** Where the raw stdout of this run was written. */
  readonly capture: string
  /**
   * Send one message and keep the events that arrived while it was in flight.
   *
   * A failed Turn is returned rather than thrown. Two of the four sends in this
   * file are expected to be a `/compact` that cannot run, and a run that threw
   * would spend the money and report nothing about the failure it was sent to
   * observe.
   */
  say(text: string): Promise<{ turn: Turn; events: ClaudeEvent[] }>
}

function probe(name: string): Probe {
  const { configDir, cwd } = liveSessionDirs(name)
  const capture = liveCaptureFile(name)
  const session = new ClaudeSession({
    sessionId: randomUUID(),
    cwd,
    env: buildEnv({ credential: sharedWindowCredential(), configDir, inherit: process.env }),
    spawn: teeing(capture),
  })
  const events: ClaudeEvent[] = []
  session.on('event', (event) => events.push(event))
  return {
    session,
    events,
    capture,
    async say(text) {
      const from = events.length
      try {
        return { turn: await session.send(text), events: events.slice(from) }
      } catch (error) {
        if (!(error instanceof TurnFailedError)) throw error
        return { turn: error.turn, events: events.slice(from) }
      }
    },
  }
}

/** The `system/compact_boundary` events a run put on stdout. */
function boundaries(events: readonly ClaudeEvent[]): ClaudeEvent[] {
  return events.filter((e) => e.type === 'system' && e['subtype'] === 'compact_boundary')
}

/**
 * The events reporting on a Compaction's outcome.
 *
 * Located by the field rather than by the subtype, which is #100's finding: the
 * outcome rides on a `system/status`, an event that also carries ordinary
 * progress, so the only thing that marks one is `compact_result`.
 */
function compactResults(events: readonly ClaudeEvent[]): ClaudeEvent[] {
  return events.filter((e) => 'compact_result' in e)
}

/**
 * The message a compacted Session is continued from, which is where the summary
 * lands and the only place a Caller's argument can be seen to have had an
 * effect.
 *
 * Synthetic rather than replayed: Claude Code writes it into the Session itself,
 * so it arrives on stdout with `isSynthetic: true` and no Caller behind it.
 */
function continuation(events: readonly ClaudeEvent[]): string | null {
  const event = events.find((e) => e.type === 'user' && e['isSynthetic'] === true)
  const message = event?.['message'] as { content?: unknown } | undefined
  return typeof message?.content === 'string' ? message.content : null
}

/** How a Turn is reported in this file's logs — one line, every figure on it. */
function figures(label: string, turn: Turn): string {
  return (
    `  ${label.padEnd(24)} num_turns=${String(turn.turns)} ` +
    `delta=${String(turn.costUsd)} total_cost_usd=${String(turn.result['total_cost_usd'])} ` +
    `${String(turn.durationMs)}ms duration_api_ms=${String(turn.result['duration_api_ms'])} ` +
    `is_error=${String(turn.isError)}`
  )
}

describe('a manual /compact with too little conversation to summarise', () => {
  // The failure a real person is most likely to hit on day one, because typing
  // `/compact` into a short thread *is* "not enough conversation to summarise" —
  // and the cheapest of the three unknowns, because a Session with one exchange
  // in it is already in the state under test.
  //
  // #98 measured this code on the *auto* path, where it arrives on
  // `system/status` as `compact_result: "failed"` / `compact_error:
  // "too_few_groups"` while the Turn stays healthy and answers. ADR-0018 carries
  // that reading forward into a table of what the Caller is told. Whether the
  // manual path reports it the same way is the question: its own switch throws
  // rather than returning a result, and what a thrown error does to a
  // non-interactive Turn is not something the auto path can answer.
  it('says so, and what it says is the whole of what roma gets', async () => {
    const { session, events, capture, say } = probe('manual-compact-too-few-groups')

    try {
      session.start()
      const { turn: setup } = await say(CHAT[0] ?? '')
      const { turn: compact, events: during } = await say(COMPACT)

      console.log(
        [
          `seam 2: manual /compact, too little conversation — capture ${capture}`,
          figures('setup', setup),
          figures('/compact', compact),
          `  result text ${JSON.stringify(compact.text)}`,
          `  compact_result ${JSON.stringify(compactResults(during).map((e) => e['compact_result']))}`,
          `  compact_error  ${JSON.stringify(compactResults(during).map((e) => e['compact_error']))}`,
          `  boundaries ${String(boundaries(during).length)}`,
        ].join('\n'),
      )

      // Nothing was summarised, so nothing may claim to have been.
      expect(boundaries(during)).toHaveLength(0)

      // The manual path's own switch throws — `case"too_few_groups":throw
      // Error(whr)` — and the frame above it catches that one error by identity
      // and returns it as ordinary command text: `S_e(i,whr)` →
      // `{type:"text",value:whr}`, where `whr` is the sentence below. So the
      // Caller is answered by the command itself rather than by a failed Turn.
      expect(compact.isError).toBe(false)
      expect(compact.text).toContain('Not enough messages to compact')

      // The finding, and it is the one ADR-0018's failure table is built on.
      // #100 measured `compact_error` on the auto path as a machine-readable
      // **code** — `too_few_groups` — and both #98 and ADR-0018 lean on that
      // being a code rather than a sentence, explicitly so as not to repeat the
      // `shared-window.ts` mistake of building on one build's strings. On this
      // path the same failure puts the *thrown error's message* there instead.
      //
      // Asserted rather than only logged, and asserted on the exact string on
      // purpose: this is a measurement of the pinned build, and a pin that moves
      // should go red here. Nothing in roma may key behaviour on it.
      const [failure] = compactResults(during)
      expect(failure, 'no compact_result reached stdout').toBeDefined()
      expect(failure?.['compact_result']).toBe('failed')
      expect(failure?.['compact_error']).toBe('Not enough messages to compact.')

      // Free, and the reason `too_few_groups` is the cheap unknown: the manual
      // path bails before it calls anything (`attempts: 0`).
      expect(compact.turns).toBe(0)
      expect(compact.costUsd).toBe(0)

      // The Session is not spent. #100 found the same on the auto path — a
      // failed Compaction is not a dead Session — and ADR-0018 leans on it.
      const { turn: after } = await say(CHAT[1] ?? '')
      expect(after.isError).toBe(false)
    } finally {
      await session.terminateOrKill()
    }
  })
})

describe('a manual /compact that works', () => {
  // The half of `E.enum(["manual","auto"])` nobody had seen. Three one-word
  // exchanges is the whole setup: a group opens at each new assistant message,
  // and the manual path needs two groups with an assistant message among the
  // ones being summarised.
  //
  // The last setup Turn is also the baseline the `/compact` is priced against.
  // Not the same comparison #100 made — that was two byte-identical messages,
  // one of which happened to carry a Compaction — and it is not pretended to be:
  // this is what a person's deliberate `/compact` costs beside an ordinary short
  // Turn in the same Session.
  it('announces itself with trigger "manual", and says what it cost', async () => {
    const { session, events, capture, say } = probe('manual-compact')

    try {
      session.start()
      for (const message of CHAT.slice(0, 2)) await say(message)
      const { turn: quiet } = await say(CHAT[2] ?? '')
      const { turn: compact, events: during } = await say(COMPACT)

      const [boundary] = boundaries(during)
      const metadata = boundary?.['compact_metadata'] as Record<string, unknown> | undefined

      console.log(
        [
          `seam 2: manual /compact — capture ${capture}`,
          figures('quiet Turn', quiet),
          figures('/compact', compact),
          `  compact_metadata ${JSON.stringify(metadata)}`,
          `  compact_result ${JSON.stringify(compactResults(during).map((e) => e['compact_result']))}`,
          `  result text ${JSON.stringify(compact.text)}`,
        ].join('\n'),
      )

      expect(boundary, 'no system/compact_boundary reached stdout').toBeDefined()
      expect(metadata).toBeDefined()

      // The measurement. Everything #98 and #100 recorded is the other value.
      expect(metadata?.['trigger']).toBe('manual')
      expect(typeof metadata?.['pre_tokens']).toBe('number')

      // A Relay that costs money, which is the whole of what ADR-0018 decided
      // and the reason it is governed as a Task. The money is visible, and it is
      // visible in exactly one place: the delta of `total_cost_usd`, which is
      // what `ClaudeSession` already prices a Turn by.
      expect(Number(compact.costUsd)).toBeGreaterThan(0)

      // And this is the finding. `num_turns` stays **zero** for a `/compact`
      // that spent real money over sixteen seconds — the same figure the four
      // free entries on the list report — and `duration_api_ms` stays zero with
      // it. So a Relay's cost cannot be inferred from either.
      //
      // ADR-0012's drift check was "a Readout reporting `num_turns !== 0` goes
      // to the Operator Log", and ADR-0018 replaced it on the grounds that it
      // "would fire on every legitimate `/compact`, and a check that cries wolf
      // is a check somebody mutes". It would not fire at all. Whatever replaces
      // it has to read the cost.
      expect(compact.turns).toBe(0)
      expect(compact.result['duration_api_ms']).toBe(0)
    } finally {
      await session.terminateOrKill()
    }
  })
})

describe("a manual /compact carrying ADR-0018's frame", () => {
  // The third unknown, and the one the argument decision rests on. Everything
  // about it was read rather than measured: that a message whose first line is
  // `/compact` and whose remainder is a Caller Marker and free text is still
  // dispatched as the command, that the argument survives the newlines, and that
  // the marker rides along into what the summariser reads.
  it('is still dispatched as the command, and carries the whole argument', async () => {
    const { session, events, capture, say } = probe('manual-compact-argument')

    try {
      session.start()
      for (const message of CHAT) await say(message)
      const { turn: compact, events: during } = await say(COMPACT_WITH_ARGUMENT)

      const [boundary] = boundaries(during)
      const metadata = boundary?.['compact_metadata'] as Record<string, unknown> | undefined

      // What the Caller's own words did to the Session, in full, because a
      // summary is the only place the argument can show up and nobody has seen
      // one yet. Logged rather than asserted: it is model output.
      const replayed = during
        .filter((e) => e.type === 'user')
        .map((e) => JSON.stringify(e['message']))

      console.log(
        [
          `seam 2: manual /compact with ADR-0018's frame — capture ${capture}`,
          `  sent ${JSON.stringify(COMPACT_WITH_ARGUMENT)}`,
          figures('/compact + argument', compact),
          `  compact_metadata ${JSON.stringify(metadata)}`,
          `  result text ${JSON.stringify(compact.text)}`,
          ...replayed.map((message) => `  replayed ${message}`),
        ].join('\n'),
      )

      // The fault ADR-0012 exists to fix, checked from the other side: a message
      // that reached the model as prose would answer *about* `/compact` and
      // compact nothing.
      expect(boundary, 'the frame was not dispatched as a command').toBeDefined()
      expect(metadata?.['trigger']).toBe('manual')
    } finally {
      await session.terminateOrKill()
    }
  })

  // The control for the test above, and the only thing that makes it evidence
  // rather than a shape that happened to pass. See SENTINEL.
  //
  // What the summariser *did* with the argument is logged and not asserted, and
  // that is a decision rather than an omission: it is model prose, it varies
  // run to run, and pinning a test to one wording would make the pin's next move
  // unreadable. The run that produced the verification document is the evidence,
  // in `test/fixtures/claude-stream/`. What is asserted here is only what the
  // pinned build decides rather than the model.
  it('hands the argument to the summariser, marker and newlines and all', async () => {
    const { session, events, capture, say } = probe('manual-compact-argument-marked')

    try {
      session.start()
      for (const message of DISCUSSION) await say(message)
      const { turn: compact, events: during } = await say(COMPACT_WITH_SENTINEL)

      const summary = continuation(during)

      console.log(
        [
          `seam 2: manual /compact, sentinel argument behind the marker — capture ${capture}`,
          `  sent ${JSON.stringify(COMPACT_WITH_SENTINEL)}`,
          figures('/compact + sentinel', compact),
          `  sentinel honoured ${String(summary?.includes(SENTINEL) ?? false)}`,
          `  summary ${JSON.stringify(summary)}`,
        ].join('\n'),
      )

      expect(boundaries(during).length, 'nothing was compacted').toBeGreaterThan(0)
      expect(summary, 'no continuation message reached stdout').toBeTruthy()
    } finally {
      await session.terminateOrKill()
    }
  })

  // The same argument over the same conversation with roma's marker removed, so
  // that the pair is a comparison rather than two anecdotes. This is the one
  // that can hold ADR-0018's accepted risk about the marker to account, because
  // it is the only difference between the two frames.
  it('is acted on differently depending on whether the marker is in front of it', async () => {
    const { session, events, capture, say } = probe('manual-compact-argument-unmarked')

    try {
      session.start()
      for (const message of DISCUSSION) await say(message)
      const { turn: compact, events: during } = await say(COMPACT_WITH_SENTINEL_UNMARKED)

      const summary = continuation(during)

      console.log(
        [
          `seam 2: manual /compact, same argument with no marker — capture ${capture}`,
          `  sent ${JSON.stringify(COMPACT_WITH_SENTINEL_UNMARKED)}`,
          figures('/compact + sentinel', compact),
          `  sentinel honoured ${String(summary?.includes(SENTINEL) ?? false)}`,
          `  summary ${JSON.stringify(summary)}`,
        ].join('\n'),
      )

      expect(boundaries(during).length, 'nothing was compacted').toBeGreaterThan(0)
      expect(summary, 'no continuation message reached stdout').toBeTruthy()
    } finally {
      await session.terminateOrKill()
    }
  })
})
