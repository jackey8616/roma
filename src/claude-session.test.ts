import { describe, expect, it } from 'vitest'
import {
  ClaudeExitedError,
  ClaudeSession,
  TranscriptNotFound,
  TurnFailedError,
  wasInterrupted,
  type Turn,
} from './claude-session.js'
import type { ClaudeEvent } from './stream-events.js'
import { FakeClaude } from '../test/support/fake-claude.js'
import { feed, recordedStream, withTotalCostUsd } from '../test/support/recorded-stream.js'

const SESSION_ID = '11111111-2222-3333-4444-555555555555'

function newSession(
  options: {
    resume?: boolean
    model?: string
    effort?: string
    appendSystemPrompt?: string
  } = {},
) {
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

const SEND_ONLY_REJECTS =
  'send must fail by rejecting, never by throwing synchronously: it is `async` so that every ' +
  'way it can fail reaches the one `.catch()` its caller wrote. A send that throws for one ' +
  'class of failure and rejects for another cannot be handled in one place (ADR-0003), and ' +
  'the caller finds out at runtime.'

function sendOrThrow(session: ClaudeSession, text: string): unknown {
  try {
    return session.send(text)
  } catch (error) {
    return error
  }
}

describe('how the process is invoked', () => {
  it('names a new Session with --session-id', () => {
    const { claude, session } = newSession()

    session.start()

    expect(claude.lastSpawn.args).toContain('--session-id')
    expect(claude.lastSpawn.args).toContain(SESSION_ID)
    expect(claude.lastSpawn.args).not.toContain('--resume')
  })

  it('reaches an existing Session with --resume and never both flags [fence:session-one-flag-never-both]', () => {
    const why =
      'A spawn names a new Session with --session-id or reaches an existing one with ' +
      '--resume, never both (ADR-0003). Measured: the CLI rejects the pair with ' +
      '"--session-id can only be used with --continue or --resume if --fork-session is also ' +
      'specified", and roma never forks, so every resume would fail to start.'
    const { claude, session } = newSession({ resume: true })

    session.start()

    expect(claude.lastSpawn.args, why).toContain('--resume')
    expect(claude.lastSpawn.args, why).not.toContain('--session-id')
  })

  it('tells the Session what it can reach, where it has been given something to say [fence:session-prompt-rides-the-flag]', () => {
    const why =
      'What a Session is told about itself must ride --append-system-prompt, never a file in ' +
      'its working directory (ADR-0008). The agent clones into that directory and runs ' +
      '`git add -A` there, so anything roma left in it would eventually be committed into ' +
      "somebody's repository."
    const { claude, session } = newSession({ appendSystemPrompt: 'you can reach a-team/roma' })

    session.start()

    const args = claude.lastSpawn.args
    expect(args[args.indexOf('--append-system-prompt') + 1], why).toBe('you can reach a-team/roma')
  })

  it('says nothing extra where there is nothing to say', () => {
    const { claude, session } = newSession()

    session.start()

    expect(claude.lastSpawn.args).not.toContain('--append-system-prompt')
  })

  it('pins the model, because it follows the credential rather than the config [fence:session-model-always-passed]', () => {
    const why =
      '--model must be passed on every spawn (ADR-0002). The model a Claude Code process runs ' +
      "on follows the credential it resolved rather than roma's config, so a spawn without " +
      '--model turns a billing change, such as moving a Task to Overflow, silently into a ' +
      'model change.'
    const { claude, session } = newSession()

    session.start()

    const args = claude.lastSpawn.args
    expect(args[args.indexOf('--model') + 1], why).toBe('claude-sonnet-5')
  })

  it('pins the effort, because omitting it falls back to a file every Session shares [fence:session-effort-always-passed]', () => {
    const why =
      '--effort must be passed on every spawn, the pinned default included (ADR-0016). ' +
      'Precedence was measured as CLAUDE_CODE_EFFORT_LEVEL > --effort > settings.effortLevel, ' +
      'and the settings file lives in the one config dir every Session shares, so an omitted ' +
      'flag lets an effortLevel left there set the effort of every Session in roma, invisibly.'
    const { claude, session } = newSession()

    session.start()

    const args = claude.lastSpawn.args
    expect(args, why).toContain('--effort')
    expect(args[args.indexOf('--effort') + 1], why).toBe('high')
  })

  it('passes the effort it was given, where a Session has been moved to one', () => {
    const { claude, session } = newSession({ effort: 'max' })

    session.start()

    const args = claude.lastSpawn.args
    expect(args[args.indexOf('--effort') + 1]).toBe('max')
  })

  it('runs the invocation the spec pins [fence:session-invocation-pinned]', () => {
    const why =
      'The claude -p invocation is pinned (ADR-0001, ADR-0003, ADR-0010). --verbose is a ' +
      'precondition of stream-json output under --print: without it the process exits before ' +
      'one event reaches the stream. --include-partial-messages is what moves the ' +
      'Acknowledgement while a Turn generates; dropped, it freezes for the whole Turn.'
    const bare =
      '--bare must never be passed (ADR-0001, ADR-0003). It skips OAuth and keychain reads and ' +
      'requires ANTHROPIC_API_KEY, so it breaks subscription auth (ADR-0002) for every Session.'
    const { claude, session } = newSession()

    session.start()

    expect(claude.lastSpawn.command).toBe('claude')
    expect(claude.lastSpawn.args, why).toEqual(
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
    expect(claude.lastSpawn.args, bare).not.toContain('--bare')
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

  it('reassembles NDJSON lines split across chunk boundaries', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('three-turns-one-process')
    session.start()

    const turn = session.send('reply with ok')
    feed(claude.process, stream.turn(1), { chunkSize: 1 })

    expect((await turn).text).toBe('ok')
  })

  it('refuses a second Turn while one is in flight [fence:session-send-only-rejects]', async () => {
    const { session } = newSession()
    session.start()

    void session.send('first').catch(() => {})

    const second = sendOrThrow(session, 'second')
    expect(second, SEND_ONLY_REJECTS).toBeInstanceOf(Promise)
    await expect(second, SEND_ONLY_REJECTS).rejects.toThrow(/in flight/)
  })

  it('refuses to send before the process is started [fence:session-send-only-rejects]', async () => {
    const { session } = newSession()

    const sent = sendOrThrow(session, 'anything')
    expect(sent, SEND_ONLY_REJECTS).toBeInstanceOf(Promise)
    await expect(sent, SEND_ONLY_REJECTS).rejects.toThrow(/not been started/)
  })
})

describe('reporting failure', () => {
  it('fails a Turn on is_error even when the subtype says success [fence:session-failure-is-a-rejection]', async () => {
    const why =
      'A failed Turn must be read off `is_error`, never `subtype`, and must reject with ' +
      'TurnFailedError rather than resolve (ADR-0003). `is_error: true` arrives beside ' +
      '`subtype: "success"` on every auth failure the prototype observed, so a reader keying ' +
      'on subtype, or a send that returns a failed Turn, reports a 401 as a completed answer.'
    const { claude, session } = newSession()
    const stream = recordedStream('auth-failure')
    session.start()

    const turn = session.send('are you there')
    feed(claude.process, stream.turn(1))

    await expect(turn, why).rejects.toBeInstanceOf(TurnFailedError)
    await turn.catch((error: TurnFailedError) => {
      expect(error.turn.subtype).toBe('success')
      expect(error.turn.isError, why).toBe(true)
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

  it('names a refused resume for the Transcript that is missing [fence:session-refused-resume-read-off-errors]', async () => {
    const { claude, session } = newSession({ resume: true })
    session.start()

    const turn = session.send('hello')
    feed(claude.process, recordedStream('resume-lost').turn(1))

    await expect(turn, REFUSED_RESUME).rejects.toBeInstanceOf(TranscriptNotFound)
    await turn.catch((error: TranscriptNotFound) => {
      expect(error.reason, REFUSED_RESUME).toContain('No conversation found')
      expect(error.turn.text).toBe('')
      expect(error.turn.costUsd).toBe(0)
    })
  })

  it('leaves a Turn that genuinely failed as one [fence:session-refused-resume-read-off-errors]', async () => {
    const { claude, session } = newSession({ resume: true })
    session.start()

    const turn = session.send('are you there')
    feed(claude.process, recordedStream('auth-failure').turn(1))

    await expect(turn, REFUSED_RESUME).rejects.toBeInstanceOf(TurnFailedError)
    await expect(turn, REFUSED_RESUME).rejects.not.toBeInstanceOf(TranscriptNotFound)
  })

  it('finds the refusal wherever it is among the errors [fence:session-refused-resume-read-off-errors]', async () => {
    const { claude, session } = newSession({ resume: true })
    session.start()

    const turn = session.send('hello')
    feed(
      claude.process,
      recordedStream('resume-lost')
        .turn(1)
        .map((event) =>
          event.type === 'result'
            ? { ...event, errors: ['something said first', ...(event['errors'] as string[])] }
            : event,
        ),
    )

    await expect(turn, REFUSED_RESUME).rejects.toBeInstanceOf(TranscriptNotFound)
  })
})

const REFUSED_RESUME =
  'A --resume refused for a missing Transcript must be recognised off every entry of the ' +
  "terminal event's `errors`, and carried in TranscriptNotFound (#107, ADR-0003). Read off " +
  '`result` it is missed, since a refused resume carries no result text and a 401 carries no ' +
  'errors; read off stderr it is a race, since the terminal event settles the Turn before ' +
  'stderr is guaranteed to have arrived. Missed, the pool never respawns under --session-id ' +
  'and the Conversation fails on every message.'

describe('per-Turn cost', () => {
  it('reports the delta rather than the running total [fence:session-cost-is-a-delta]', async () => {
    const why =
      "A Turn's cost is the difference between consecutive `total_cost_usd` readings, never " +
      'the reading itself (ADR-0003, observability). The figure is cumulative for the process, ' +
      'so logged raw the fifth Task a process serves is billed on its Audit Record at the sum ' +
      'of Tasks one through five.'
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

    expect(
      ended.map((turn) => turn.costUsd),
      why,
    ).toEqual([expect.closeTo(0.0103129, 7), expect.closeTo(0, 7), expect.closeTo(0.0019952, 7)])
    expect(session.cumulativeCostUsd).toBeCloseTo(0.0123081, 7)
  })

  it('prices nothing it was not told, and bills the next total from the last one known [fence:session-unreported-is-null-not-zero]', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('three-turns-one-process')
    const ended: Turn[] = []
    session.on('turn-end', (turn) => ended.push(turn))
    session.start()

    const unpriced = stream.turn(2).map((event) => {
      if (event.type !== 'result') return event
      const { total_cost_usd, ...rest } = event
      void total_cost_usd
      return rest as ClaudeEvent
    })
    for (const events of [stream.turn(1), unpriced, stream.turn(3)]) {
      const turn = session.send('a message')
      feed(claude.process, events)
      await turn.catch(() => {})
    }

    expect(ended[1]?.costUsd, UNREPORTED_IS_NULL).toBeNull()
    expect(ended[2]?.costUsd, UNREPORTED_IS_NULL).toBeCloseTo(0.0019952, 7)
  })

  it('starts a resumed process from zero rather than from what the Session spent', async () => {
    const { claude, session } = newSession({ resume: true })
    const stream = recordedStream('three-turns-one-process')
    session.start()

    const turn = session.send('carrying on after an eviction')
    feed(claude.process, withTotalCostUsd(stream.turn(1), 0.0105342))

    expect((await turn).costUsd).toBeCloseTo(0.0105342, 7)
  })

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

  it('says there was nothing to interrupt when no Turn is in flight [fence:session-interrupt-needs-a-turn]', async () => {
    const why =
      'interrupt() must send nothing and answer false when no Turn is in flight (ADR-0003, ' +
      '/stop). A person can /stop a second after sending, while the process is still ' +
      'starting; sending the control request anyway would let the Turn run to completion ' +
      'while the Conversation was told it had been stopped.'
    const { claude, session } = newSession()
    const stream = recordedStream('interrupted-turn')
    session.start()

    expect(session.interrupt(), why).toBe(false)
    expect(claude.process.sent, why).toEqual([])

    const turn = session.send('sleep for a while')
    expect(session.interrupt()).toBe(true)

    feed(claude.process, stream.turn(1))
    await expect(turn).rejects.toBeInstanceOf(TurnFailedError)
    expect(session.interrupt(), why).toBe(false)
  })

  it('marks an interrupted Turn as interrupted rather than merely failed [fence:session-interrupted-read-off-terminal-reason]', async () => {
    const { claude, session } = newSession()
    const stream = recordedStream('interrupted-turn')
    session.start()

    const turn = session.send('sleep for a while')
    session.interrupt()
    feed(claude.process, stream.turn(1))

    await expect(turn, INTERRUPTED).rejects.toSatisfy((error: TurnFailedError) =>
      wasInterrupted(error.turn),
    )
    const finished = session.send('are you still alive')
    feed(claude.process, stream.turn(2))
    expect(wasInterrupted(await finished), INTERRUPTED).toBe(false)
  })

  it('does not read every execution error as an interruption [fence:session-interrupted-read-off-terminal-reason]', async () => {
    const { claude, session } = newSession()
    session.start()

    const turn = session.send('sleep for a while')
    feed(
      claude.process,
      recordedStream('interrupted-turn')
        .turn(1)
        .map((event) => (event.type === 'result' ? { ...event, terminal_reason: null } : event)),
    )

    await expect(turn, INTERRUPTED).rejects.toSatisfy(
      (error: TurnFailedError) =>
        error.turn.subtype === 'error_during_execution' && !wasInterrupted(error.turn),
    )
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

  it('kills a process that ignores SIGTERM, and says it had to [fence:session-kill-when-term-is-ignored]', async () => {
    const why =
      'terminateOrKill must escalate to SIGKILL once the grace runs out. Ending a process is ' +
      'always awaited by somebody, so a wedged process that ignores SIGTERM otherwise stalls ' +
      'them: eviction holds up every later message, the "bot halted" state ADR-0003 lists, ' +
      'and the startup self-check hangs the boot.'
    const claude = new FakeClaude({ exitOnKill: true })
    const session = new ClaudeSession({
      sessionId: SESSION_ID,
      cwd: `/work/${SESSION_ID}`,
      env: {},
      spawn: claude.spawn,
    })
    session.start()
    claude.process.ignore('SIGTERM')
    let expired = false

    const ended = session.terminateOrKill(10, () => {
      expired = true
    })
    const outcome = await Promise.race([
      ended.then(() => 'ended' as const),
      new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 500)),
    ])

    expect(outcome, why).toBe('ended')
    expect(claude.process.signals, why).toEqual(['SIGTERM', 'SIGKILL'])
    expect(expired, why).toBe(true)
    expect(session.alive).toBe(false)
  })
})

const INTERRUPTED =
  'Whether a Turn was interrupted must be read off `terminal_reason` (`aborted_streaming`, ' +
  'measured in interrupted-turn.jsonl), never off `subtype` (ADR-0003). `subtype` says ' +
  '`error_during_execution` for any error during execution, so read off it every failure ' +
  'is reported as a /stop somebody asked for.'

describe('a generating Turn', () => {
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
  it('fails a Turn whose process never started', async () => {
    const { claude, session } = newSession()
    session.start()

    const turn = session.send('anything')
    claude.process.emitError(new Error('spawn claude ENOENT'))

    await expect(turn).rejects.toThrow(/ENOENT/)
  })

  it('surfaces what the process wrote to stderr', () => {
    const { claude, session } = newSession()
    const stderr: string[] = []
    session.on('stderr', (chunk) => stderr.push(chunk))
    session.start()

    claude.process.emitStderr('Error: --output-format=stream-json requires --verbose\n')

    expect(stderr.join('')).toContain('requires --verbose')
  })

  it('keeps the cost baseline current when a result arrives with no Turn in flight [fence:session-unrequested-result-moves-the-baseline]', async () => {
    const why =
      'The cost baseline must be rebased on every terminal event, whether or not a Turn was ' +
      'waiting for it (ADR-0003, observability). A result nobody asked for still moved ' +
      '`total_cost_usd`, and a baseline left behind folds that spend into the next Turn’s ' +
      'delta — the cumulative-total bug arriving by a different route (#19).'
    const { claude, session } = newSession()
    const stream = recordedStream('three-turns-one-process')
    session.start()

    feed(claude.process, stream.turn(1))
    expect(session.cumulativeCostUsd, why).toBeCloseTo(0.0103129, 7)

    const turn = session.send('and now a real one')
    feed(claude.process, stream.turn(3))

    expect((await turn).costUsd, why).toBeCloseTo(0.0019952, 7)
  })
})

describe('per-Turn output tokens', () => {
  it('reports what the Turn added rather than the process total [fence:session-compact-reports-no-turns]', async () => {
    const why =
      'A Turn must carry both `outputTokens` and `turns`, and on the recorded /compact they ' +
      'must disagree: 1978 output tokens and zero Turns (ADR-0018). That disagreement is why ' +
      'the Relay drift check reads output tokens rather than num_turns, and `turns` is kept ' +
      'though nothing in the Core reads it, because it is the field that records the ' +
      'measurement. Deleting it loses the evidence the check was re-keyed on.'
    const { claude, session } = newSession()
    const stream = recordedStream('manual-compaction')
    const ended: Turn[] = []
    session.on('turn-end', (turn) => ended.push(turn))
    session.start()

    for (const n of [1, 2, 3, 4]) {
      const turn = session.send(`message ${n}`)
      feed(claude.process, stream.turn(n))
      await turn.catch(() => {})
    }

    expect(
      ended.map((turn) => turn.outputTokens),
      why,
    ).toEqual([21, 7, 8, 1978])
    expect(
      ended.map((turn) => turn.turns),
      why,
    ).toEqual([1, 1, 1, 0])
  })

  it('reads an empty modelUsage as no output at all', async () => {
    const { claude, session } = newSession()
    session.start()

    const turn = session.send('/context\n\n<from>Ada (users/17)</from>')
    feed(claude.process, recordedStream('readout-context').turn(1))

    expect((await turn).outputTokens).toBe(0)
  })

  it('never reports a negative Turn, however the breakdown moves [fence:session-output-tokens-never-negative]', async () => {
    const why =
      "A Turn's output tokens are measured above a high-water mark and floored at zero, never " +
      'a plain delta (ADR-0018). modelUsage is a breakdown that is not stable across a ' +
      "process's life: here the third Turn drops a model entry and reports fewer tokens. A " +
      'plain delta reads that as negative, and the baseline it leaves makes the next ordinary ' +
      'Turn a burst the Relay drift check blames on an innocent entry.'
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

    expect(
      ended.map((turn) => turn.outputTokens),
      why,
    ).toEqual([17, 0, 0])
  })

  it('says nothing rather than zero where the field is absent [fence:session-unreported-is-null-not-zero]', async () => {
    const { claude, session } = newSession()
    session.start()

    const turn = session.send('hello')
    feed(
      claude.process,
      recordedStream('three-turns-one-process')
        .turn(1)
        .map((event) => {
          if (event.type !== 'result') return event
          const { modelUsage, ...rest } = event
          void modelUsage
          return rest as ClaudeEvent
        }),
    )

    expect((await turn).outputTokens, UNREPORTED_IS_NULL).toBeNull()
  })
})

const UNREPORTED_IS_NULL =
  'A figure the terminal event did not carry must be null, never zero, and must leave the ' +
  'baseline where it was (ADR-0003, ADR-0018). Zero says the Turn was free or did no model ' +
  'work; a build that quietly stopped reporting would then record every Task in roma as ' +
  'free and retire the Relay drift check, where null is a Turn nobody can price.'
