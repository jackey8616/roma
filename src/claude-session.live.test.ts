import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { relayed } from './attribution.js'
import { buildEnv } from './build-env.js'
import { spawnClaudeProcess } from './claude-process.js'
import { ClaudeSession, type Turn } from './claude-session.js'
import { readToolNames, type ClaudeEvent } from './stream-events.js'
import { liveSessionDirs, sharedWindowCredential } from '../test/support/live-claude.js'
import {
  randomStripes,
  stripeColourNames,
  stripeColoursIn,
  stripedPng,
  stripesInPng,
} from '../test/support/striped-png.js'

const PING = 'Reply with exactly the word PING and nothing else. Do not use any tools.'
const RECALL = 'What word did I ask you to reply with? Answer with just that word.'

describe('a Session over a real claude -p', () => {
  const sessionId = randomUUID()
  const events: ClaudeEvent[] = []
  const turns: Turn[] = []
  const pids: (number | undefined)[] = []
  let session: ClaudeSession

  beforeAll(async () => {
    const { configDir, cwd } = liveSessionDirs(sessionId)
    session = new ClaudeSession({
      sessionId,
      cwd,
      env: buildEnv({ credential: sharedWindowCredential(), configDir, inherit: process.env }),
    })
    session.on('event', (event) => events.push(event))
    session.start()

    turns.push(await session.send(PING))
    pids.push(session.pid)
    turns.push(await session.send(RECALL))
    pids.push(session.pid)
  })

  afterAll(async () => {
    if (session.alive) await session.terminate()
  })

  it('returns the completed Turn text', () => {
    expect(turns[0]?.text).toContain('PING')
  })

  it('serves the second message from the same process, with context retained', () => {
    expect(session.alive).toBe(true)
    expect(pids[0]).toBeDefined()
    expect(pids[1]).toBe(pids[0])
    expect(turns[1]?.text).toContain('PING')
  })

  it('re-emits system/init per Turn without restarting the process', () => {
    const inits = events.filter((e) => e.type === 'system' && e['subtype'] === 'init')
    expect(inits.length).toBe(2)
  })

  it('resolves the Shared Window credential without falling through to an API key', () => {
    const init = events.find((e) => e.type === 'system' && e['subtype'] === 'init')
    expect(init?.['apiKeySource']).toBe('none')
    expect(init?.['model']).toBe('claude-sonnet-5')
    console.log(`seam 2 ran against Claude Code ${String(init?.['claude_code_version'])}`)
  })

  it('reports per-Turn cost as a delta of the running total', () => {
    const [first, second] = turns
    expect(first?.costUsd).toBeGreaterThan(0)
    expect(second?.costUsd).toBeGreaterThan(0)
    expect(session.cumulativeCostUsd).toBeCloseTo((first?.costUsd ?? 0) + (second?.costUsd ?? 0), 9)
    expect(second?.costUsd).toBeLessThan(session.cumulativeCostUsd)
  })

  it('emits partial-message events during the Turn', () => {
    const deltas = events.filter((e) => e.type === 'stream_event')
    expect(deltas.length).toBeGreaterThan(0)
  })
})

const STRIPE_COUNT = 5
const MINTED = 'a3f9c2.png'
const MINTED_AGAIN = 'b7d1e4.png'

function stripeQuestion(): string {
  return (
    `The image has ${STRIPE_COUNT} horizontal stripes. Name their colours from top to bottom. ` +
    `Each stripe is exactly one of: ${stripeColourNames().join(', ')}. ` +
    `Answer with the ${STRIPE_COUNT} names in order, comma separated, lowercase, and nothing else.`
  )
}

describe('an Enclosure on disk, read by the agent', () => {
  const sessionId = randomUUID()
  const events: ClaudeEvent[] = []
  const turns: Turn[] = []
  const marks: number[] = []
  const stripes = randomStripes(STRIPE_COUNT)
  const stripesAgain = randomStripes(STRIPE_COUNT)
  let cwd: string
  let session: ClaudeSession

  const toolsIn = (turn: number): string[] =>
    events.slice(marks[turn], marks[turn + 1]).flatMap(readToolNames)

  beforeAll(async () => {
    const dirs = liveSessionDirs('enclosure')
    cwd = dirs.cwd
    writeFileSync(join(cwd, MINTED), stripedPng(stripes))
    writeFileSync(join(cwd, MINTED_AGAIN), stripedPng(stripesAgain))

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
    turns.push(
      await session.send(
        `<from>Ada (users/17)</from>\n` +
          `<enclosure path="./${MINTED}" name="screenshot.png" />\n\n` +
          stripeQuestion(),
      ),
    )
    marks.push(events.length)
    turns.push(
      await session.send(
        `Use the Read tool on ./${MINTED_AGAIN}, and use no other tool. ${stripeQuestion()}`,
      ),
    )
    marks.push(events.length)
  }, 240_000)

  afterAll(async () => {
    if (session.alive) await session.terminate()
    const init = events.find((e) => e.type === 'system' && e['subtype'] === 'init')
    console.log(
      [
        `enclosure seam 2 — Claude Code ${String(init?.['claude_code_version'])}, ` +
          `$${session.cumulativeCostUsd.toFixed(6)} over ${turns.length} Turns`,
        `  marker    wrote ${stripes.join(',')}`,
        `            tools ${toolsIn(0).join(',') || '<none>'}`,
        `            said  ${JSON.stringify(turns[0]?.text ?? '<no Turn>')}`,
        `  read-only wrote ${stripesAgain.join(',')}`,
        `            tools ${toolsIn(1).join(',') || '<none>'}`,
        `            said  ${JSON.stringify(turns[1]?.text ?? '<no Turn>')}`,
      ].join('\n'),
    )
  })

  it('wrote the images it meant to write', () => {
    expect(stripesInPng(readFileSync(join(cwd, MINTED)))).toEqual(stripes)
    expect(stripesInPng(readFileSync(join(cwd, MINTED_AGAIN)))).toEqual(stripesAgain)
  })

  it('goes and reads the file, given nothing but the enclosure marker', () => {
    expect(toolsIn(0)).toContain('Read')
    expect(stripeColoursIn(turns[0]?.text ?? '')).toEqual(stripes)
  })

  it('renders the image through the Read tool and nothing else', () => {
    expect(new Set(toolsIn(1))).toEqual(new Set(['Read']))
    expect(stripeColoursIn(turns[1]?.text ?? '')).toEqual(stripesAgain)
  })
})

const RELAY_CALLER = { caller: 'users/17', callerName: 'Ada' }
const CONTEXT = { command: '/context', argument: null }

describe("a free Relay on roma's own invocation path", () => {
  const sessionId = randomUUID()
  const turns: Turn[] = []
  let session: ClaudeSession

  beforeAll(async () => {
    const { configDir, cwd } = liveSessionDirs('free-relay')
    session = new ClaudeSession({
      sessionId,
      cwd,
      env: buildEnv({ credential: sharedWindowCredential(), configDir, inherit: process.env }),
    })
    session.start()

    turns.push(await session.send(relayed(RELAY_CALLER, CONTEXT)))
    turns.push(await session.send(PING))
    turns.push(await session.send(relayed(RELAY_CALLER, CONTEXT)))
  }, 240_000)

  afterAll(async () => {
    if (session.alive) await session.terminate()
    const labels = ['cold relay', 'task', 'warm relay']
    console.log(
      [
        `free relay seam 2 (#85) — $${session.cumulativeCostUsd.toFixed(6)} over ${turns.length} sends`,
        ...turns.map((turn, i) => {
          const raw = turn.result['total_cost_usd']
          return (
            `  ${(labels[i] ?? '?').padEnd(13)} num_turns=${String(turn.turns)} ` +
            `out=${String(turn.outputTokens)} ` +
            `delta=${String(turn.costUsd)} total_cost_usd=${String(raw)}`
          )
        }),
      ].join('\n'),
    )
  })

  it('drives no Turn and costs nothing on a process that has not spent', () => {
    expect(turns[0]?.turns).toBe(0)
    expect(turns[0]?.costUsd).toBe(0)
    expect(turns[0]?.text).toContain('Context Usage')
  })

  it('still costs nothing on a process that has already spent', () => {
    expect(turns[1]?.costUsd).toBeGreaterThan(0)

    expect(turns[2]?.turns).toBe(0)
    expect(turns[2]?.costUsd).toBe(0)
    expect(session.cumulativeCostUsd).toBe(turns[1]?.costUsd)
  })
})

async function runClaude(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const { configDir, cwd } = liveSessionDirs(`flags-${args.join('-').replace(/\W+/g, '')}`)
  const stderr: string[] = []
  return await new Promise((resolve) => {
    const proc = spawnClaudeProcess({
      command: 'claude',
      args,
      cwd,
      env: buildEnv({ credential: sharedWindowCredential(), configDir, inherit: process.env }),
    })
    proc.onStderr((chunk) => stderr.push(chunk))
    proc.onExit(({ code }) => resolve({ code, stderr: stderr.join('') }))
    proc.closeStdin()
  })
}

describe('--session-id and --resume', () => {
  it('are refused together, and refused for that reason rather than a missing Session', async () => {
    const sessionId = randomUUID()

    const both = await runClaude(['-p', '--session-id', sessionId, '--resume', sessionId])
    const resumeOnly = await runClaude(['-p', '--resume', sessionId])

    expect(both.code).not.toBe(0)
    expect(both.stderr).toContain('--session-id can only be used with')
    expect(resumeOnly.stderr).toContain('No conversation found')

    expect(both.stderr).toContain('--fork-session')
  })
})

describe('--output-format stream-json under --print', () => {
  it('refuses to start without --verbose', async () => {
    const withoutVerbose = await runClaude([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ])

    expect(withoutVerbose.code).not.toBe(0)
    expect(withoutVerbose.stderr).toContain('requires --verbose')
  })
})
