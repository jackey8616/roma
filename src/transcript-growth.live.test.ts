import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import { ClaudeSession, type Turn } from './claude-session.js'
import { readToolNames, type ClaudeEvent } from './stream-events.js'
import { liveSessionDirs, sharedWindowCredential } from '../test/support/live-claude.js'

const BUILD = [
  'Create three files in the current directory, one Write call each.',
  '- `queue.ts`: a FIFO queue class in TypeScript with `push`, `pop` and `size`, each with a short doc comment.',
  '- `queue.test.ts`: vitest tests covering an empty queue, one push then one pop, and ordering across three pushes.',
  '- `README.md`: one paragraph saying what the module is for.',
  'Then read all three back with the Read tool, and reply with one line per file: its name and its line count.',
  'Do not run any shell commands.',
].join('\n')

const EXTEND = [
  'Add a `peek()` method to `queue.ts` that returns the next item without removing it.',
  'Update `queue.test.ts` with a test for it and `README.md` with a sentence about it.',
  'Then read all three files back with the Read tool, and reply with one line per file: its name and its line count.',
  'Do not run any shell commands.',
].join('\n')

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

  it('lands where the collision verification says it does', () => {
    expect(found, 'no Transcript for this Session under projects/').toBeDefined()
    expect([slugOf(cwd), slugOf(realpathSync(cwd))]).toContain(found)
  })

  it('ran two Turns that actually used tools', () => {
    expect(turns[0]?.isError).toBe(false)
    expect(turns[1]?.isError).toBe(false)
    expect(toolsIn(0)).toContain('Write')
    expect(toolsIn(0)).toContain('Read')
    expect(toolsIn(1)).toContain('Read')
  })

  it('grows with the second Turn, on one Session', () => {
    const [first, second] = readings
    expect(first?.bytes).toBeGreaterThan(0)
    expect(second?.bytes).toBeGreaterThan(first?.bytes ?? 0)
    expect(second?.lines).toBeGreaterThan(first?.lines ?? 0)
  })
})
