import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import { ClaudeSession, type Turn } from './claude-session.js'
import { readToolNames, type ClaudeEvent } from './stream-events.js'
import { liveSessionDirs, sharedWindowCredential } from '../test/support/live-claude.js'

// SEAM 2 — a real `claude -p`. Slow, and it spends Shared Window quota.
// Excluded from `npm test` by living in its own config; run it with
// `npm run test:seam2`.
//
// #41's missing number. That ticket is an accepted cost rather than a defect —
// ADR-0006 has roma delete nothing from `ROMA_CLAUDE_CONFIG_DIR`, and the
// operator who names that directory needs to know how fast it grows — but the
// figure it carried was an extrapolation from the wrong artifact. A recorded
// **stdout** stream is not a Transcript: 202 of the 209 events in
// `generation-partial-messages.jsonl` are `stream_event` deltas that
// `--include-partial-messages` puts on stdout, and nothing establishes that any
// of them reach the file on disk.
//
// The only real Transcript measurement in the repository is one
// `Reply with OK` Turn at 14,089 bytes (`docs/transcript-collision-verification.md`),
// which is a Session's one-off records more than it is a Turn. #41 says what is
// needed instead, in as many words: one substantial tool-using Turn, then a
// second on the same Session, so the per-Turn delta separates from the
// per-Session overhead. That is what this does.
//
// Sizes are logged rather than asserted. A test that failed because a Turn came
// out 8% larger would be measuring the model's mood, and the number belongs in a
// document, not in an expectation.

/** A Task with real work in it: several Writes, several Reads, one reply. */
const BUILD = [
  'Create three files in the current directory, one Write call each.',
  '- `queue.ts`: a FIFO queue class in TypeScript with `push`, `pop` and `size`, each with a short doc comment.',
  '- `queue.test.ts`: vitest tests covering an empty queue, one push then one pop, and ordering across three pushes.',
  '- `README.md`: one paragraph saying what the module is for.',
  'Then read all three back with the Read tool, and reply with one line per file: its name and its line count.',
  'Do not run any shell commands.',
].join('\n')

/** A second Task of the same shape, on the same Session. */
const EXTEND = [
  'Add a `peek()` method to `queue.ts` that returns the next item without removing it.',
  'Update `queue.test.ts` with a test for it and `README.md` with a sentence about it.',
  'Then read all three files back with the Read tool, and reply with one line per file: its name and its line count.',
  'Do not run any shell commands.',
].join('\n')

/** Tasks a day, for the only arithmetic anybody actually wants out of this. */
const TASKS_PER_DAY = 100

interface Reading {
  readonly bytes: number
  readonly lines: number
}

function read(path: string): Reading {
  return {
    bytes: statSync(path).size,
    lines: readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '').length,
  }
}

/**
 * Claude Code's own name for a working directory, as
 * `docs/transcript-collision-verification.md` recorded it: `/Users/x/y` becomes
 * `-Users-x-y`.
 */
function slugOf(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

describe('what a Turn adds to the Transcript', () => {
  const sessionId = randomUUID()
  const events: ClaudeEvent[] = []
  const turns: Turn[] = []
  const marks: number[] = []
  const readings: Reading[] = []
  let cwd: string
  let projects: string
  let found: string | undefined
  let session: ClaudeSession

  const toolsIn = (turn: number): string[] =>
    events.slice(marks[turn], marks[turn + 1]).flatMap(readToolNames)

  const existsIn = (dir: string, name: string): boolean => readdirSync(dir).includes(name)

  /**
   * The Transcript for this Session, located rather than computed.
   *
   * The mapping is Claude Code's own and undocumented, and on macOS `tmpdir()`
   * is a symlink — so a path built from the slug alone would fail as "no
   * Transcript" when what actually happened is that it is one directory over.
   * Found by its filename, which is the Session id and unambiguous; the
   * directory it was found *in* is then something to assert rather than to
   * assume.
   */
  const locate = (): string | undefined =>
    readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .find((entry) => existsIn(join(projects, entry.name), `${sessionId}.jsonl`))?.name

  beforeAll(async () => {
    const dirs = liveSessionDirs('transcript-growth')
    cwd = dirs.cwd
    projects = join(dirs.configDir, 'projects')

    session = new ClaudeSession({
      sessionId,
      cwd,
      env: buildEnv({
        credential: sharedWindowCredential(),
        configDir: dirs.configDir,
        inherit: process.env,
      }),
    })
    session.on('event', (event) => events.push(event))
    session.start()

    marks.push(events.length)
    turns.push(await session.send(BUILD))
    marks.push(events.length)
    found = locate()
    if (found !== undefined) readings.push(read(join(projects, found, `${sessionId}.jsonl`)))

    turns.push(await session.send(EXTEND))
    marks.push(events.length)
    if (found !== undefined) readings.push(read(join(projects, found, `${sessionId}.jsonl`)))
  }, 300_000)

  // The whole point of the run, and in the hook so that a run which spent the
  // money leaves the number behind even when an assertion is what failed.
  afterAll(async () => {
    if (session.alive) await session.terminate()
    const init = events.find((e) => e.type === 'system' && e['subtype'] === 'init')
    const [first, second] = readings
    const perTurn = (second?.bytes ?? 0) - (first?.bytes ?? 0)
    const overhead = (first?.bytes ?? 0) - perTurn
    const perYear = (perTurn * TASKS_PER_DAY * 365) / 1_000_000_000
    console.log(
      [
        `transcript seam 2 (#41) — Claude Code ${String(init?.['claude_code_version'])}, ` +
          `$${session.cumulativeCostUsd.toFixed(6)} over ${turns.length} Turns`,
        `  transcript ${String(found)}/${sessionId}.jsonl`,
        `  cwd        ${cwd}`,
        ...turns.map((turn, i) => {
          const reading = readings[i]
          return (
            `  turn ${i + 1}     ${String(reading?.bytes).padStart(7)} bytes  ` +
            `${String(reading?.lines).padStart(4)} lines  ` +
            `$${(turn.costUsd ?? 0).toFixed(6)}  ` +
            `${String(events.slice(marks[i], marks[i + 1]).length).padStart(4)} stdout events  ` +
            `tools: ${toolsIn(i).join(',') || '<none>'}`
          )
        }),
        `  per Turn   ${perTurn} bytes (turn 2 minus turn 1)`,
        `  per Session${String(overhead).padStart(8)} bytes of one-off records`,
        `  at ${TASKS_PER_DAY} Tasks a day, ${perYear.toFixed(2)} GB a year of Turns`,
      ].join('\n'),
    )
  })

  // The path #41 and ADR-0006 both talk about, pinned. An operator is told to
  // give this directory durable storage; a repository that could not say which
  // file it meant would be asking them to keep something on trust.
  it('lands where the collision verification says it does', () => {
    expect(found, 'no Transcript for this Session under projects/').toBeDefined()
    // Either spelling of the working directory — macOS hands out a `/var`
    // symlink for a `/private/var` directory, and which one Claude Code slugs is
    // its business rather than this test's.
    expect([slugOf(cwd), slugOf(realpathSync(cwd))]).toContain(found)
  })

  // Both Turns have to have *worked* for the sizes to mean anything. #41 asks
  // for "a real tool-using Task, not `Reply with OK`" precisely because the one
  // measurement it already had was the trivial kind, and a Turn that answered
  // out of the model without touching a file would quietly reproduce it.
  it('ran two Turns that actually used tools', () => {
    expect(turns[0]?.isError).toBe(false)
    expect(turns[1]?.isError).toBe(false)
    expect(toolsIn(0)).toContain('Write')
    expect(toolsIn(0)).toContain('Read')
    expect(toolsIn(1)).toContain('Read')
  })

  // The measurement's own precondition: two readings of one file, the second
  // strictly larger. Without this the delta is not a per-Turn cost — it is two
  // numbers that happen to differ.
  it('grows with the second Turn, on one Session', () => {
    const [first, second] = readings
    expect(first?.bytes).toBeGreaterThan(0)
    expect(second?.bytes).toBeGreaterThan(first?.bytes ?? 0)
    expect(second?.lines).toBeGreaterThan(first?.lines ?? 0)
  })
})
