import { describe, expect, it } from 'vitest'
import {
  ClaudeExitedError,
  ClaudeSession,
  TurnFailedError,
  wasInterrupted,
  type Turn,
} from './claude-session.js'
import { FakeClaude } from '../test/support/fake-claude.js'
import { feed, recordedStream, withTotalCostUsd } from '../test/support/recorded-stream.js'

const SESSION_ID = '11111111-2222-3333-4444-555555555555'

function newSession(options: { resume?: boolean; model?: string } = {}) {
  const claude = new FakeClaude()
  const session = new ClaudeSession({
    sessionId: SESSION_ID,
    cwd: `/work/${SESSION_ID}`,
    env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
    spawn: claude.spawn,
    ...options,
  })
  return { claude, session }
}

describe('how the process is invoked', () => {
  it('names a new Session with --session-id', () => {
    const { claude, session } = newSession()

    session.start()

    expect(claude.lastSpawn.args).toContain('--session-id')
    expect(claude.lastSpawn.args).toContain(SESSION_ID)
    expect(claude.lastSpawn.args).not.toContain('--resume')
  })

  // The CLI refuses the two flags together unless --fork-session is present, and
  // roma never forks (ADR-0003). One boolean produces exactly one of them; there
  // is no way to ask for both.
  it('reaches an existing Session with --resume and never both flags', () => {
    const { claude, session } = newSession({ resume: true })

    session.start()

    expect(claude.lastSpawn.args).toContain('--resume')
    expect(claude.lastSpawn.args).not.toContain('--session-id')
  })

  it('pins the model, because it follows the credential rather than the config', () => {
    const { claude, session } = newSession()

    session.start()

    const args = claude.lastSpawn.args
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5')
  })

  // --verbose is in here because the CLI requires it: "When using --print,
  // --output-format=stream-json requires --verbose". Pinned so it cannot be
  // tidied away as noise; seam 2 checks that the requirement is still real.
  it('runs the invocation the spec pins', () => {
    const { claude, session } = newSession()

    session.start()

    expect(claude.lastSpawn.command).toBe('claude')
    expect(claude.lastSpawn.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--replay-user-messages',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
      ]),
    )
    // --bare skips OAuth and requires ANTHROPIC_API_KEY, which would break
    // subscription auth entirely.
    expect(claude.lastSpawn.args).not.toContain('--bare')
  })

  it('runs in the Session working directory with only the environment it was given', () => {
    const { claude, session } = newSession()

    session.start()

    expect(claude.lastSpawn.cwd).toBe(`/work/${SESSION_ID}`)
    expect(claude.lastSpawn.env).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    })
  })
})

// Every stream below is a recording of a real `claude -p`, not a hand-written
// double. The numbers asserted against them were read out of the captures
// themselves — see test/fixtures/claude-stream/README.md.

describe('completing a Turn', () => {
  it('returns the completed Turn text', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('three-turns-one-process')
    session.start()

    const turn = session.send('reply with ok')
    feed(claude.process, stream.turn(1))

    expect((await turn).text).toBe('ok')
  })

  it('sends the message as one NDJSON frame on stdin', () => {
    const { claude, session } = newSession()
    session.start()

    void session.send('reply with ok').catch(() => {})

    expect(claude.process.sent).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'reply with ok' }] },
        parent_tool_use_id: null,
        session_id: SESSION_ID,
      },
    ])
  })

  // The OS decides where stdout chunks end, and it does not care about our
  // newlines. One byte at a time is the worst case of the same thing.
  it('reassembles NDJSON lines split across chunk boundaries', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('three-turns-one-process')
    session.start()

    const turn = session.send('reply with ok')
    feed(claude.process, stream.turn(1), { chunkSize: 1 })

    expect((await turn).text).toBe('ok')
  })

  it('refuses a second Turn while one is in flight', async () => {
    const { session } = newSession()
    session.start()

    void session.send('first').catch(() => {})

    await expect(session.send('second')).rejects.toThrow(/in flight/)
  })

  it('refuses to send before the process is started', async () => {
    const { session } = newSession()

    await expect(session.send('anything')).rejects.toThrow(/not been started/)
  })
})

describe('reporting failure', () => {
  // The failure this whole design exists to avoid: `is_error: true` arriving
  // alongside `subtype: "success"`. A wrapper keying on subtype reports a 401 as
  // a completed answer.
  it('fails a Turn on is_error even when the subtype says success', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('auth-failure')
    session.start()

    const turn = session.send('are you there')
    feed(claude.process, stream.turn(1))

    await expect(turn).rejects.toBeInstanceOf(TurnFailedError)
    await turn.catch((error: TurnFailedError) => {
      expect(error.turn.subtype).toBe('success')
      expect(error.turn.isError).toBe(true)
      expect(error.turn.text).toContain('401')
    })
  })

  it('fails a Turn whose process dies underneath it', async () => {
    const { claude, session } = newSession()
    session.start()

    const turn = session.send('something long')
    claude.process.emitExit({ code: null, signal: 'SIGTERM' })

    await expect(turn).rejects.toBeInstanceOf(ClaudeExitedError)
  })
})

describe('per-Turn cost', () => {
  // total_cost_usd on the terminal event is cumulative for the process:
  // 0.0103129 → 0.0103129 → 0.0123081 across these three Turns. Logged raw, the
  // third Turn would be recorded at the price of all three.
  it('reports the delta rather than the running total', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('three-turns-one-process')
    const ended: Turn[] = []
    session.on('turn-end', (turn) => ended.push(turn))
    session.start()

    for (const n of [1, 2, 3]) {
      const turn = session.send(`message ${n}`)
      feed(claude.process, stream.turn(n))
      await turn.catch(() => {})
    }

    expect(ended.map((turn) => turn.costUsd)).toEqual([
      expect.closeTo(0.0103129, 7),
      expect.closeTo(0, 7),
      expect.closeTo(0.0019952, 7),
    ])
    expect(session.cumulativeCostUsd).toBeCloseTo(0.0123081, 7)
  })

  // A resumed process counts its own spend from zero rather than continuing the
  // Session's, which is what lets the baseline live here instead of in whatever
  // outlives the process. Measured at seam 2; the figures are in ADR-0003's
  // observability section.
  it('starts a resumed process from zero rather than from what the Session spent', async () => {
    const { claude, session } = newSession({ resume: true })
    const stream = recordedStream('three-turns-one-process')
    session.start()

    const turn = session.send('carrying on after an eviction')
    feed(claude.process, withTotalCostUsd(stream.turn(1), 0.0105342))

    expect((await turn).costUsd).toBeCloseTo(0.0105342, 7)
  })

  // A Turn that failed still spent money, so the audit record still needs it.
  it('reports the cost of a failed Turn too', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('interrupted-turn')
    session.start()

    const turn = session.send('sleep for a while')
    feed(claude.process, stream.turn(1))

    await expect(turn).rejects.toSatisfy(
      (error: TurnFailedError) => error.turn.costUsd === 0.000625,
    )
  })
})

describe('staying resident', () => {
  // system/init is re-emitted at the start of every Turn. A wrapper reading it
  // as "a new process started" would tear down a perfectly good Session.
  it('serves every Turn from the same process despite a system/init per Turn', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('three-turns-one-process')
    const inits: unknown[] = []
    session.on('event', (event) => {
      if (event.type === 'system' && event['subtype'] === 'init') inits.push(event)
    })
    session.start()

    for (const n of [1, 2, 3]) {
      const turn = session.send(`message ${n}`)
      feed(claude.process, stream.turn(n))
      await turn.catch(() => {})
    }

    expect(inits).toHaveLength(3)
    expect(claude.processes).toHaveLength(1)
    expect(session.alive).toBe(true)
  })

  it('interrupts in band, and the process survives to serve the next Turn', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('interrupted-turn')
    session.start()

    const interrupted = session.send('sleep for a while')
    session.interrupt()
    feed(claude.process, stream.turn(1))
    await expect(interrupted).rejects.toBeInstanceOf(TurnFailedError)

    const next = session.send('are you still alive')
    feed(claude.process, stream.turn(2))

    expect(claude.process.sent[1]).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    })
    expect(claude.process.signals).toEqual([])
    expect((await next).text).toBe('alive')
  })

  // What roma reports "there was nothing to stop" from. Sending the control
  // request regardless would be the same call whether or not it interrupted
  // anything, and `/stop` a second after sending — while the process is still
  // starting — would end nothing while saying it had.
  it('says there was nothing to interrupt when no Turn is in flight', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('interrupted-turn')
    session.start()

    expect(session.interrupt()).toBe(false)
    expect(claude.process.sent).toEqual([])

    const turn = session.send('sleep for a while')
    expect(session.interrupt()).toBe(true)

    feed(claude.process, stream.turn(1))
    await expect(turn).rejects.toBeInstanceOf(TurnFailedError)
    expect(session.interrupt()).toBe(false)
  })

  // The one field that separates the ending somebody asked for from the ones
  // nobody did. `subtype` says `error_during_execution`, which is what any error
  // during execution says.
  it('marks an interrupted Turn as interrupted rather than merely failed', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('interrupted-turn')
    session.start()

    const turn = session.send('sleep for a while')
    session.interrupt()
    feed(claude.process, stream.turn(1))

    await expect(turn).rejects.toSatisfy((error: TurnFailedError) => wasInterrupted(error.turn))
    const finished = session.send('are you still alive')
    feed(claude.process, stream.turn(2))
    expect(wasInterrupted(await finished)).toBe(false)
  })

  it('ends the process on terminate and reports how it exited', async () => {
    const { claude, session } = newSession()
    session.start()

    const exited = session.terminate()
    claude.process.emitExit({ code: 143, signal: null })

    expect(claude.process.signals).toEqual(['SIGTERM'])
    expect(await exited).toEqual({ code: 143, signal: null })
    expect(session.alive).toBe(false)
  })
})

describe('a generating Turn', () => {
  // With --include-partial-messages the same prose arrives twice: once as 194
  // text_delta events, and once more as the complete assistant message 85ms
  // before the terminal result. A Turn that reads both reports the essay twice.
  it('reports prose that arrives twice as text exactly once', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('generation-partial-messages')
    session.start()

    const turn = session.send('write an essay about unix pipes')
    feed(claude.process, stream.turn(1))

    const { text } = await turn
    expect(text).toHaveLength(17706)
    expect(text.split('# The Pipe: How a Single Character Reshaped Computing')).toHaveLength(2)
  })

  // Generation is otherwise silent, so this is the only thing a progress
  // renderer has to read while a long answer is being written.
  it('surfaces the partial-message events a progress renderer reads', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('generation-partial-messages')
    const streamed: string[] = []
    session.on('event', (event) => {
      if (event.type === 'stream_event') streamed.push(event.type)
    })
    session.start()

    const turn = session.send('write an essay about unix pipes')
    feed(claude.process, stream.turn(1))
    await turn

    expect(streamed.length).toBeGreaterThan(190)
  })
})

describe('when the process misbehaves', () => {
  // `claude` missing from PATH surfaces as a spawn error, not an exit. Without
  // this the Turn would hang forever on a process that never existed.
  it('fails a Turn whose process never started', async () => {
    const { claude, session } = newSession()
    session.start()

    const turn = session.send('anything')
    claude.process.emitError(new Error('spawn claude ENOENT'))

    await expect(turn).rejects.toThrow(/ENOENT/)
  })

  // The only place a process explains itself when it refuses to run at all.
  it('surfaces what the process wrote to stderr', () => {
    const { claude, session } = newSession()
    const stderr: string[] = []
    session.on('stderr', (chunk) => stderr.push(chunk))
    session.start()

    claude.process.emitStderr('Error: --output-format=stream-json requires --verbose\n')

    expect(stderr.join('')).toContain('requires --verbose')
  })

  // A terminal result with nothing waiting for it still moved the running total.
  // Left out of the running total, its spend is folded into the next Turn — the
  // cumulative-total bug arriving by a different route.
  it('keeps the cost baseline current when a result arrives with no Turn in flight', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('three-turns-one-process')
    session.start()

    feed(claude.process, stream.turn(1))
    expect(session.cumulativeCostUsd).toBeCloseTo(0.0103129, 7)

    const turn = session.send('and now a real one')
    feed(claude.process, stream.turn(3))

    expect((await turn).costUsd).toBeCloseTo(0.0019952, 7)
  })
})
