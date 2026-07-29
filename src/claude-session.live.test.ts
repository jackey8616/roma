import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import { spawnClaudeProcess } from './claude-process.js'
import { ClaudeSession, type Turn } from './claude-session.js'
import type { ClaudeEvent } from './stream-events.js'
import { liveSessionDirs, sharedWindowCredential } from '../test/support/live-claude.js'

// SEAM 2 — a real `claude -p`. Slow, and it spends Shared Window quota.
// Excluded from `npm test` by living in its own config; run it with
// `npm run test:seam2`.
//
// It exists because the whole architecture rests on this stream contract, and
// asserting that contract from documentation is the exact failure this project
// already made once. Behaviour is version-specific: the version in use is
// recorded from system/init below rather than assumed.

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

  // The entire justification for keeping a process resident. If the second Turn
  // needed a cold start, or lost the first Turn's context, the pool has no
  // reason to exist.
  it('serves the second message from the same process, with context retained', () => {
    expect(session.alive).toBe(true)
    // The pid is what makes this "the same process" rather than "a process".
    expect(pids[0]).toBeDefined()
    expect(pids[1]).toBe(pids[0])
    expect(turns[1]?.text).toContain('PING')
  })

  // system/init arrives at the start of every Turn, not once per process.
  // Anything treating it as a spawn signal would tear this Session down.
  it('re-emits system/init per Turn without restarting the process', () => {
    const inits = events.filter((e) => e.type === 'system' && e['subtype'] === 'init')
    expect(inits.length).toBe(2)
  })

  // The two silent-degradation modes ADR-0003's startup self-check exists to
  // catch. Asserted here because this is the only place a real credential
  // resolves against a real CLI.
  it('resolves the Shared Window credential without falling through to an API key', () => {
    const init = events.find((e) => e.type === 'system' && e['subtype'] === 'init')
    expect(init?.['apiKeySource']).toBe('none')
    expect(init?.['model']).toBe('claude-sonnet-5')
    // Recorded rather than asserted: behaviour is version-specific, so a future
    // failure needs to know which build produced this baseline.
    console.log(`seam 2 ran against Claude Code ${String(init?.['claude_code_version'])}`)
  })

  // total_cost_usd is a cumulative total for the process. Two Turns is the
  // smallest run that can tell a delta apart from it.
  it('reports per-Turn cost as a delta of the running total', () => {
    const [first, second] = turns
    expect(first?.costUsd).toBeGreaterThan(0)
    expect(second?.costUsd).toBeGreaterThan(0)
    expect(session.cumulativeCostUsd).toBeCloseTo((first?.costUsd ?? 0) + (second?.costUsd ?? 0), 9)
    // The giveaway: logged raw, the second Turn would be billed for both.
    expect(second?.costUsd).toBeLessThan(session.cumulativeCostUsd)
  })

  // --include-partial-messages is required, not optional: without it the stream
  // is silent through generation and there is nothing to render progress from.
  it('emits partial-message events during the Turn', () => {
    const deltas = events.filter((e) => e.type === 'stream_event')
    expect(deltas.length).toBeGreaterThan(0)
  })
})

/** Run `claude` to its exit, for the invocations that are meant to be refused. */
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

// The constraint the Session's one `resume` boolean encodes. It is worth a live
// check because the design depends on the CLI genuinely rejecting both flags —
// if it ever accepted them, the pool's first-spawn-versus-resume rule would be
// solving a problem that no longer exists.
describe('--session-id and --resume', () => {
  it('are refused together, and refused for that reason rather than a missing Session', async () => {
    const sessionId = randomUUID()

    const both = await runClaude(['-p', '--session-id', sessionId, '--resume', sessionId])
    const resumeOnly = await runClaude(['-p', '--resume', sessionId])

    // The message names the flag combination, so this failure cannot be the
    // "that Session does not exist" failure wearing a disguise — the control
    // is what that one actually looks like.
    expect(both.code).not.toBe(0)
    expect(both.stderr).toContain('--session-id can only be used with')
    expect(resumeOnly.stderr).toContain('No conversation found')

    // Narrows a claim this ticket inherited. The prototype reported the two
    // flags as flatly mutually exclusive; the CLI's own wording says they
    // combine when --fork-session is present. roma never forks, so one boolean
    // still picks between them, but the reason is the narrower one.
    expect(both.stderr).toContain('--fork-session')
  })
})

// --verbose is a precondition of the output format, not a verbosity preference.
// Pinned so it reads as a requirement rather than as clutter someone tidies away
// — an invocation missing it produces no events at all. ADR-0003's invocation
// block cites this test.
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
