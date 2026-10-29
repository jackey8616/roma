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

/** What `send` hands back, or what it threw before it could hand anything back. */
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

  // The CLI refuses the two flags together unless --fork-session is present, and
  // roma never forks (ADR-0003). One boolean produces exactly one of them; there
  // is no way to ask for both.
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

  // A capability nobody knows about is a capability nobody has: an agent in an
  // empty directory has no reason to believe it can clone anything, and will
  // explain that it has no access rather than trying. `--append-system-prompt`
  // rather than a file in the working directory, because the agent runs
  // `git add -A` in there and anything roma left behind would eventually be
  // committed into somebody's repository (ADR-0008).
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

  /**
   * On every spawn, including the Sessions nobody has touched.
   *
   * Omitting it does not fall back to nothing — it falls back to an
   * `effortLevel` in the settings file under the config dir, which is one per
   * deployment, so a value left there would set the effort for every Session in
   * roma invisibly. Precedence was measured as `CLAUDE_CODE_EFFORT_LEVEL` >
   * `--effort` > `settings.effortLevel` (ADR-0016): passing this closes the
   * bottom of that list, and `buildEnv`'s allowlist closes the top.
   */
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

  // --verbose is in here because the CLI requires it: "When using --print,
  // --output-format=stream-json requires --verbose". Pinned so it cannot be
  // tidied away as noise; seam 2 checks that the requirement is still real.
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
  // The failure this whole design exists to avoid: `is_error: true` arriving
  // alongside `subtype: "success"`. A wrapper keying on subtype reports a 401 as
  // a completed answer.
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

  // The fourth ending, and the one that is barely a Turn: nothing ran and
  // nothing was spent, because the CLI refused before it called anything. Named
  // here rather than worked out by whoever catches it — the pool wants it so it
  // can spawn under the other flag and the Core wants it so it can say something
  // better than "roma could not run this Task.", and neither can be the one that
  // knows.
  it('names a refused resume for the Transcript that is missing [fence:session-refused-resume-read-off-errors]', async () => {
    const { claude, session } = newSession({ resume: true })
    session.start()

    const turn = session.send('hello')
    feed(claude.process, recordedStream('resume-lost').turn(1))

    await expect(turn, REFUSED_RESUME).rejects.toBeInstanceOf(TranscriptNotFound)
    await turn.catch((error: TranscriptNotFound) => {
      // Carried in the error rather than looked up when somebody wants it. The
      // terminal event settles the Turn as it is parsed, and the matching stderr
      // line is on another pipe that may not have been delivered yet.
      expect(error.reason, REFUSED_RESUME).toContain('No conversation found')
      // The Turn is still there to be audited, and it is why this ending needs a
      // name at all: it carries no text whatsoever, so anything reading a failed
      // Turn's own words about itself gets nothing.
      expect(error.turn.text).toBe('')
      expect(error.turn.costUsd).toBe(0)
    })
  })

  // The constraint the fix had to hold: these are two different endings and only
  // one of them is recoverable by spawning again. A 401 puts its sentence in
  // `result` and carries no `errors` at all.
  it('leaves a Turn that genuinely failed as one [fence:session-refused-resume-read-off-errors]', async () => {
    const { claude, session } = newSession({ resume: true })
    session.start()

    const turn = session.send('are you there')
    feed(claude.process, recordedStream('auth-failure').turn(1))

    await expect(turn, REFUSED_RESUME).rejects.toBeInstanceOf(TurnFailedError)
    await expect(turn, REFUSED_RESUME).rejects.not.toBeInstanceOf(TranscriptNotFound)
  })

  // `errors` is an array in the stream and roma has only ever seen one entry in
  // it. The refusal is looked for in all of them, so a build that puts another
  // sentence first does not turn a recoverable ending into a failure.
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
  // total_cost_usd on the terminal event is cumulative for the process:
  // 0.0103129 → 0.0103129 → 0.0123081 across these three Turns. Logged raw, the
  // third Turn would be recorded at the price of all three.
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

  // No capture holds a terminal event without a total; this is what a build that
  // stopped reporting one would look like, built out of a real Turn.
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

  // The same recorded ending with its `terminal_reason` taken away: what any other
  // error during execution looks like, which says `error_during_execution` too.
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

// What the Relay drift check reads, and the only field that can see a
// `type:"local"` command doing model work: on a manual `/compact` the top-level
// `usage` is all zeros, `duration_api_ms` is 0 and `num_turns` is 0, while
// `modelUsage` moves.
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

    // 21 → 28 → 36 → 2014 across the four, summed across both models the capture
    // names. The fourth is the `/compact`, and it is the only one of the four
    // that reports `num_turns: 0`.
    expect(
      ended.map((turn) => turn.outputTokens),
      why,
    ).toEqual([21, 7, 8, 1978])
    expect(
      ended.map((turn) => turn.turns),
      why,
    ).toEqual([1, 1, 1, 0])
  })

  // The empty object a free Relay reports, which is a Turn that produced nothing
  // rather than a build that stopped saying.
  it('reads an empty modelUsage as no output at all', async () => {
    const { claude, session } = newSession()
    session.start()

    const turn = session.send('/context\n\n<from>Ada (users/17)</from>')
    feed(claude.process, recordedStream('readout-context').turn(1))

    expect((await turn).outputTokens).toBe(0)
  })

  // **The reading that goes backwards, and it is a real capture on the pinned
  // build.** One process: the third Turn drops the `claude-haiku-4-5` entry and
  // reports fewer `outputTokens` for `claude-sonnet-5` than the Turn before it,
  // while `total_cost_usd` climbs as it should. Reported faithfully that is a
  // negative Turn and a baseline left below where it had been — and the *next*
  // ordinary Turn would then look like a burst of model work, on an entry that
  // did nothing wrong. So the mark holds and the Turn reports zero.
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

  // A build that stopped reporting the object is a different fact from a Turn
  // that produced nothing, and only one of the two should be able to retire the
  // check that reads this.
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
