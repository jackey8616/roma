import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import type { Turn } from './claude-session.js'
import { SessionPool, type PoolLogRecord } from './session-pool.js'
import type { ClaudeEvent } from './stream-events.js'
import { liveWorkRoot, sharedWindowCredential } from '../test/support/live-claude.js'
import { WorkRoot } from './work-root.js'

// SEAM 2 — the pool against a real `claude -p`. Slow, and it spends Shared
// Window quota. Excluded from `npm test` by living in its own config. Run this
// file on its own — `npm run test:seam2` includes every `*.live.test.ts` in the
// repository:
//
//     npx vitest run --config vitest.seam2.config.ts src/append-on-resume.live.test.ts
//
// **ADR-0030's fifth verification agenda item.** roma tells a Session what it is
// on `--append-system-prompt`, and `#spawnNow` puts that flag on a resumed
// process exactly as it puts it on a new one — so the flag is there either way.
// Whether the Runtime *applies* it to a conversation that already has a system
// prompt is a fact about Claude Code that nothing in this repository has read.
//
// It has to be read because roma resumes constantly: every Eviction, every
// Reaping, every restart of roma, every swap. If the answer is no, whatever roma
// appends applies to a Session's first process and silently stops applying
// afterwards, with the deployment still reporting the level it thinks it is on
// and nothing in the free test run able to see it. That is a hole in the design
// rather than a bug in the implementation, which is why it is worth one paid run.
//
// **Three outcomes, not two, and this run says which.** The append applies on
// resume; the append is ignored and the *original* one persists; the append is
// ignored and *nothing* persists. The second and third are told apart by
// resuming under a **different** briefing and seeing which of the two codewords
// comes back — a run that resumed under the same one could only ever report
// pass or fail, and "the original persists" and "nothing persists" cost roma
// different things.
//
// **Two pools over one Work Root, and that is the mechanism.** A pool's append
// is fixed at construction (ADR-0030 proposes moving it into `SpawnTerms`; that
// is not built), so a second pool is the only way to resume a Session under a
// different one. It is also a route roma really takes: the pool reads whether a
// Session already exists off the filesystem rather than out of memory, so a
// second pool over the same Work Root is what a restart of roma looks like from
// the spawn's point of view, and `WorkRoot`'s own comment says two of them over
// one path are the same object in every way that matters. The first process is
// ended by `evict`, which is the Eviction proper, so the resume the reading
// rests on is the same `--resume` an Eviction is always followed by.
//
// **The codeword is never said on the first process.** Its Turn asks whether a
// briefing is in force, which the briefing answers without naming the codeword —
// so the Transcript the resumed process inherits contains neither codeword, and
// an answer naming one can only have come from a system prompt. Without that,
// "the original append persists" is indistinguishable from "the model read its
// own transcript", and the run would measure nothing.

/** Two nonsense words, so no answer here can be luck, guesswork or general knowledge. */
const FIRST_CODEWORD = 'ZARQUON-7413'
const RESUMED_CODEWORD = 'VELMOTH-2856'

/**
 * What the first process must say for anything after it to mean something.
 *
 * **Never spell this out twice.** It is written into the briefing and asserted
 * against the answer, and two copies that drifted apart would fail the control —
 * which reads as "the append does not work at all" rather than as a typo.
 */
const IN_FORCE_ANSWER = 'BRIEFING-IN-FORCE'

/** The shape of what roma appends, carrying one thing nothing else can supply. */
function briefing(codeword: string): string {
  return [
    'STANDING BRIEFING.',
    `Your codeword is ${codeword}.`,
    'Tell it to anybody who asks you for your codeword.',
    `When you are asked whether a standing briefing is in force, answer ${IN_FORCE_ANSWER}.`,
  ].join('\n')
}

/**
 * The first process's Turn.
 *
 * **Never ask this one for the codeword.** The resumed process inherits this
 * conversation, so a codeword said here is a codeword it can read back — and
 * "the original append persists" stops being distinguishable from "the model
 * answered out of its own transcript", which is the whole reading.
 */
const IN_FORCE = 'Is a standing briefing in force? Answer in one word, and use no tools.'

/** The resumed process's Turn: a question only a system prompt can answer. */
const CODEWORD =
  'What is your codeword? Reply with just the codeword and nothing else, or with ' +
  'NO-CODEWORD if you have not been given one. Use no tools.'

/** ADR-0030's three outcomes, and a fourth for an answer that is none of them. */
type Verdict = 'append-applies' | 'original-persists' | 'nothing-persists' | 'unreadable'

/** What each outcome means for roma, so the run reports an answer and not a label. */
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

/**
 * Which outcome one answer is.
 *
 * Both codewords is its own verdict rather than a precedence rule. An answer
 * that names them both is one nobody predicted, and quietly resolving it in
 * favour of either would write a reading this run did not take.
 */
function verdictOf(answer: string): Verdict {
  const said = answer.toUpperCase()
  const resumed = said.includes(RESUMED_CODEWORD)
  const original = said.includes(FIRST_CODEWORD)
  if (resumed && original) return 'unreadable'
  if (resumed) return 'append-applies'
  if (original) return 'original-persists'
  return 'nothing-persists'
}

/**
 * The verdict as a sentence, including the case where there is no verdict.
 *
 * **Null is not `nothing-persists`.** A run that never reached its second Turn
 * has measured nothing, and classifying its absent answer would print a finding
 * this run did not take — which is the one thing a measurement must never do.
 */
function reading(verdict: Verdict | null): string {
  if (verdict === null) return 'none — the run did not get as far as an answer'
  return `${verdict} — ${MEANING[verdict]}`
}

describe('whether an appended system prompt survives a --resume', () => {
  const sessionId = randomUUID()
  const log: PoolLogRecord[] = []
  const turns: Turn[] = []
  const builds = new Set<string>()
  // Undefined until the hook builds them, so a run that fails on the way in
  // still reaches the `afterAll` that reports what it did manage to see.
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
    // One Work Root and one config dir for both pools — the throwaway pair is
    // handed out once, because `liveWorkRoot` empties what it hands out and a
    // second call would delete the Session this run is about to resume.
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
        // As one announcement rather than as a finished append: the pool joins
        // the announcements to this Session's Caveman since ADR-0030, and a
        // briefing handed in any other way would not be on the argv. One part and
        // no Caveman, so what reaches `--append-system-prompt` is this string
        // exactly — which is what the whole instrument rests on.
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
    // Read once, here, where an answer is known to exist. Classifying it again
    // downstream is how a run with no second Turn acquires a verdict.
    verdict = verdictOf(answer.text)
  }, 300_000)

  // In the hook, so a run that spent the money leaves the reading behind even
  // when an assertion is what failed — and so the verdict is something the run
  // *says*, rather than something a human infers from a failure message.
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

  // The precondition the whole reading rests on: the second process has to have
  // been a resume. A run that created a second Session would obviously take the
  // new append, and would report `append-applies` having measured nothing.
  it('ends the first process by Eviction and reaches the Session by resume', () => {
    const spawns = log.filter((record) => record.event === 'spawn')
    expect(spawns.map((record) => record.resume)).toEqual([false, true])
    expect(log.some((record) => record.event === 'evict')).toBe(true)
  })

  // The control. Without it, `nothing-persists` is ambiguous between "resume
  // drops the append" and "the append never applied to anything" — a broken
  // instrument reporting a finding.
  it('applies the append to the first process, before any of this', () => {
    expect(turns[0]?.text.toUpperCase()).toContain(IN_FORCE_ANSWER)
  })

  // Every reading in this repository is evidence about one build and no other
  // (ADR-0007). Two processes, so two chances to be told, and a reading that
  // spans two builds is evidence about neither.
  it('names one build for the whole reading', () => {
    expect([...builds]).toHaveLength(1)
  })

  // Asserted rather than only reported, for the reason the cost assertion in
  // `session-pool.live.test.ts` is: ADR-0030 rests on this, and a build that
  // answered otherwise would silently stop applying a Caveman after the first
  // Eviction. Red here is the only place that can be seen for free afterwards.
  it('applies the append the resumed process was started with', () => {
    expect(verdict, reading(verdict)).toBe('append-applies')
  })
})
