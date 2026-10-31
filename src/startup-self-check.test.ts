import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEnv, type Credential } from './build-env.js'
import {
  PINNED_EFFORT,
  TERMINATE_GRACE_MS,
  TurnFailedError,
  type ClaudeSession,
  type Turn,
} from './claude-session.js'
import {
  relayCommand,
  reportsEffort,
  startupSelfCheck,
  StartupSelfCheckFailed,
  type SelfCheckLogRecord,
} from './startup-self-check.js'
import type { ClaudeEvent } from './stream-events.js'
import { FakeClaude, flush } from '../test/support/fake-claude.js'
import {
  EFFORT_ANSWERS,
  FAILED,
  feed,
  OK,
  STRAY_KEY,
  upToFirst,
} from '../test/support/recorded-stream.js'

const DEAD_TOKEN = [...OK.slice(0, -1), ...FAILED.slice(-1)]

const EMPTY_TURN: Turn = {
  text: '',
  costUsd: null,
  durationMs: 0,
  isError: true,
  subtype: 'error_during_execution',
  stopReason: null,
  terminalReason: null,
  turns: null,
  outputTokens: null,
  result: { type: 'result' },
}

const OAUTH: Credential = { kind: 'shared-window', oauthToken: 'token' }
const OVERFLOW: Credential = { kind: 'overflow', apiKey: 'sk-ant-key' }

function withInit(events: readonly ClaudeEvent[], patch: Record<string, unknown>): ClaudeEvent[] {
  return events.map((event) =>
    event.type === 'system' && event['subtype'] === 'init' ? { ...event, ...patch } : event,
  )
}

let dirs: string[] = []

interface SelfCheckRun {
  readonly credential?: Credential
  readonly model?: string
  readonly effort?: string
  readonly timeoutMs?: number
  readonly events?: readonly ClaudeEvent[] | null
  readonly effortAnswer?: readonly ClaudeEvent[] | null
}

function selfCheck({
  credential = OAUTH,
  model,
  effort,
  timeoutMs,
  events = OK,
  effortAnswer = EFFORT_ANSWERS.at(effort ?? PINNED_EFFORT),
}: SelfCheckRun = {}) {
  const claude = new FakeClaude({ exitOnKill: true })
  const cwd = mkdtempSync(join(tmpdir(), 'roma-self-check-'))
  dirs.push(cwd)
  const log: SelfCheckLogRecord[] = []

  const check = startupSelfCheck({
    credential,
    env: buildEnv({ credential, inherit: {}, configDir: '/work/claude-home' }),
    cwd,
    spawn: claude.spawn,
    log: (record) => log.push(record),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  check.catch(() => {})

  const answered = flush().then(async () => {
    if (events === null) return
    feed(claude.process, events)
    await flush()
    if (effortAnswer !== null) feed(claude.process, effortAnswer)
  })

  return { claude, log, check: answered.then(() => check) }
}

async function failures(check: Promise<unknown>) {
  const error = await check.catch((thrown: unknown) => thrown)
  if (!(error instanceof StartupSelfCheckFailed)) {
    throw new Error(`expected the self-check to fail, got ${String(error)}`)
  }
  return error
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('the startup self-check', () => {
  it('passes when the credential resolves to the Shared Window on the pinned model', async () => {
    const { check } = selfCheck()

    await expect(check).resolves.toMatchObject({
      apiKeySource: 'none',
      model: 'claude-sonnet-5',
      claudeCodeVersion: '2.1.220',
    })
  })

  it('fails when the credential resolves to an API key instead [fence:startup-self-check-catches-a-stray-key]', async () => {
    const why =
      'The self-check must refuse to start when a Shared Window probe reports apiKeySource ' +
      '"ANTHROPIC_API_KEY" (ADR-0002, ADR-0003). A key that reaches Claude Code overrides the ' +
      'subscription on every non-interactive run, with no warning, and is otherwise learned ' +
      'about from an invoice.'
    const { check } = selfCheck({
      events: upToFirst(withInit(OK, { apiKeySource: 'ANTHROPIC_API_KEY' }), 'system/init'),
    })

    const { failures: failed } = await failures(check)
    expect(
      failed.map((failure) => failure.condition),
      why,
    ).toEqual(['credential'])
  })

  it('reports every condition that failed, not only the first [fence:startup-self-check-reports-every-failure]', async () => {
    const why =
      'The self-check must report every condition that failed, not stop at the first (#27). ' +
      'They arrive together and are not independent: a stray key moves apiKeySource and can ' +
      'take the model with it, and an operator told only about the model goes looking for a ' +
      'config change that never happened.'
    const { check } = selfCheck({ events: STRAY_KEY })

    const { failures: failed } = await failures(check)
    expect(
      failed.map((failure) => failure.condition),
      why,
    ).toEqual(['credential', 'model'])
  })

  it('refuses at system/init without waiting for the Turn', async () => {
    const { check } = selfCheck({
      events: upToFirst(withInit(OK, { apiKeySource: 'ANTHROPIC_API_KEY' }), 'system/init'),
    })

    await expect(check).rejects.toThrow(StartupSelfCheckFailed)
  })

  it('fails when the model is not the pinned one, on a credential that is right', async () => {
    const { check } = selfCheck({ events: withInit(OK, { model: 'claude-opus-5[1m]' }) })

    const { failures: failed } = await failures(check)
    expect(failed.map((failure) => failure.condition)).toEqual(['model'])
  })

  it('fails when the credential resolves correctly but does not work', async () => {
    const { check } = selfCheck({ events: DEAD_TOKEN })

    const { failures: failed } = await failures(check)
    expect(failed.map((failure) => failure.condition)).toEqual(['turn'])
    expect(failed[0]?.detail).toContain('401')
  })

  it('says which condition failed and what to go and look at', async () => {
    const { check } = selfCheck({ events: STRAY_KEY })

    const error = await failures(check)
    expect(error.message).toContain('apiKeySource is "ANTHROPIC_API_KEY", expected "none"')
    expect(error.message).toContain('CLAUDE_CONFIG_DIR')
    expect(error.failures.every((failure) => failure.check !== '')).toBe(true)
  })

  it('fails rather than waiting forever when nothing answers', async () => {
    const { check } = selfCheck({ events: null, timeoutMs: 5 })

    const { failures: failed } = await failures(check)
    expect(failed.map((failure) => failure.condition)).toEqual(['timeout'])
  })

  it('gives up on a probe process that ignores SIGTERM [fence:startup-self-check-always-ends-the-probe]', async () => {
    const why =
      'The self-check must end its probe with terminateOrKill, never a bare terminate (#27). ' +
      'The path that most needs the probe gone is the deadline, and a process that blew the ' +
      'deadline is exactly the one that may not answer SIGTERM: waiting on its exit holds the ' +
      'refusal behind an unbounded wait and turns the check that exists to stop a hang into one.'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { claude, check } = selfCheck({ events: null, timeoutMs: 5_000 })
      const refused = failures(check)
      await flush()
      claude.process.ignore('SIGTERM')

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(TERMINATE_GRACE_MS)

      expect(claude.process.signals, why).toEqual(['SIGTERM', 'SIGKILL'])
      const { failures: failed } = await refused
      expect(
        failed.map((failure) => failure.condition),
        why,
      ).toEqual(['timeout'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('expects an API key rather than none under the Overflow credential', async () => {
    const { check } = selfCheck({ credential: OVERFLOW, events: OK })

    const { failures: failed } = await failures(check)
    expect(failed[0]?.condition).toBe('credential')
    expect(failed[0]?.detail).toContain('expected "ANTHROPIC_API_KEY"')
  })

  it('probes with roma’s own -p invocation, never an auth subcommand [fence:startup-self-check-probes-with-p]', async () => {
    const why =
      'The self-check must drive a live `-p` Turn, invoked exactly as roma invokes Sessions, ' +
      'and never `claude auth status` (#27): that reports loggedIn: true for any non-empty ' +
      'string, including a token that 401s on first use — the failure that costs a morning.'
    const { claude, check } = selfCheck()
    await check

    expect(
      claude.spawns.map(({ args }) => args.includes('auth')),
      why,
    ).not.toContain(true)
    expect(claude.lastSpawn.command, why).toBe('claude')
    expect(claude.lastSpawn.args, why).toContain('-p')
    expect(claude.lastSpawn.args, why).not.toContain('auth')
    expect(claude.lastSpawn.args, why).toEqual(
      expect.arrayContaining(['--model', 'claude-sonnet-5', '--output-format', 'stream-json']),
    )
  })

  it('runs the probe on a Session of its own, new every boot [fence:startup-self-check-probe-is-its-own-session]', async () => {
    const why =
      'The probe must run on a fresh Session id, spawned new and never resumed (#27). Nothing ' +
      'roma serves is on it, so a probe Turn cannot land in anybody’s context — on a fixed or ' +
      'real Session id, or resumed, it lands in a Transcript somebody else is reading.'
    const first = selfCheck()
    await first.check
    const second = selfCheck()
    await second.check
    const idOf = ({ args }: { args: readonly string[] }) => args[args.indexOf('--session-id') + 1]

    for (const { claude } of [first, second]) {
      expect(claude.lastSpawn.args, why).toContain('--session-id')
      expect(claude.lastSpawn.args, why).not.toContain('--resume')
    }
    expect(idOf(first.claude.lastSpawn), why).not.toBe(idOf(second.claude.lastSpawn))
  })

  it('refuses a Turn that completed with no system/init [fence:startup-self-check-refuses-without-init]', async () => {
    const why =
      'A probe Turn with no system/init event must refuse the boot as `init` (#27): apiKeySource ' +
      'and the model are both read from it, so a stream without one would pass the self-check ' +
      'having checked nothing.'
    const { check } = selfCheck({
      events: OK.filter((event) => !(event.type === 'system' && event['subtype'] === 'init')),
    })

    const { failures: failed } = await failures(check)
    expect(
      failed.map((failure) => failure.condition),
      why,
    ).toEqual(['init'])
  })

  it('ends the probe process whether it passed or failed [fence:startup-self-check-always-ends-the-probe]', async () => {
    const why =
      'The self-check must end its probe on every path, passed or refused (#27): a probe left ' +
      'running holds a Session nobody will ever send to, and on the failing path it is a ' +
      'process roma has just decided it does not trust.'
    const passed = selfCheck()
    await passed.check
    const refused = selfCheck({ events: STRAY_KEY })
    await failures(refused.check)

    expect(passed.claude.process.signals, why).toContain('SIGTERM')
    expect(refused.claude.process.signals, why).toContain('SIGTERM')
  })
})

describe('what the probe says about its effort', () => {
  it('spawns at the effort roma pinned, and relays a command to ask about it', async () => {
    const { claude, check } = selfCheck({ effort: 'max', effortAnswer: EFFORT_ANSWERS.at('max') })
    await check

    const args = claude.lastSpawn.args
    expect(args[args.indexOf('--effort') + 1]).toBe('max')
    expect(claude.process.sent.at(-1)).toMatchObject({
      message: { content: [{ text: '/effort current' }] },
    })
  })

  it('reports agreement, and says nothing to an operator about it', async () => {
    const { log, check } = selfCheck()
    const report = await check

    expect(report.effort).toEqual({
      pinned: PINNED_EFFORT,
      reported: expect.any(String),
      agrees: true,
    })
    expect(log).toEqual([])
  })

  it('agrees however the sentence around the level is worded', async () => {
    const { log, check } = selfCheck({
      effort: 'ultracode',
      effortAnswer: EFFORT_ANSWERS.ultracode(),
    })

    expect((await check).effort.agrees).toBe(true)
    expect(log).toEqual([])
  })

  it('writes a disagreement to the Operator Log and starts anyway', async () => {
    const { log, check } = selfCheck({ effort: 'max', effortAnswer: EFFORT_ANSWERS.at('low') })
    const report = await check

    expect(report.apiKeySource).toBe('none')
    expect(report.effort).toMatchObject({ pinned: 'max', agrees: false })
    expect(log).toEqual([
      { event: 'effort-unverified', pinned: 'max', reported: expect.stringContaining('low') },
    ])
  })

  it('does not accept an unpinned answer that happens to name the pinned level [fence:startup-self-check-auto-vetoes]', async () => {
    const why =
      'An effort answer naming `auto` must disagree with every pinned level (#110). The build ' +
      'says "Effort level: auto (currently high)" when nothing pinned one, and high is the ' +
      'Pinned Effort of every deployment without ROMA_EFFORT — so a bare level-word match ' +
      'passes on the default deployment exactly when --effort is missing (ADR-0016).'
    const { log, check } = selfCheck({ effortAnswer: EFFORT_ANSWERS.unpinned(PINNED_EFFORT) })

    expect((await check).effort.agrees, why).toBe(false)
    expect(log, why).toHaveLength(1)
  })

  it('does not read xhigh as high [fence:startup-self-check-effort-word-boundaries]', () => {
    const why =
      'The pinned level must be matched as a whole word, not a substring (#110): `high` is ' +
      'inside `xhigh`, so a Session pinned at high would accept an answer of xhigh.'
    expect(reportsEffort('Current effort level: xhigh', 'high'), why).toBe(false)
    expect(reportsEffort('Current effort level: xhigh', 'xhigh'), why).toBe(true)
  })

  it('treats a relay that answered nothing as a disagreement, and still starts', async () => {
    const { log, check } = selfCheck({ effortAnswer: FAILED })
    const report = await check

    expect(report.effort.agrees).toBe(false)
    expect(log).toHaveLength(1)
  })

  it.each([
    ['a process that died', new Error('the process exited')],
    ['a failed Turn that said nothing', new TurnFailedError(EMPTY_TURN)],
  ])(
    'answers null rather than throwing for %s [fence:startup-self-check-relay-never-throws]',
    async (_, failure) => {
      const why =
        'relayCommand must answer null rather than throw when the process said nothing (#110): ' +
        'its only caller is boot, and the effort question is the one condition that must never ' +
        'refuse it (ADR-0016).'
      const session = { send: () => Promise.reject(failure) } as unknown as ClaudeSession

      expect(
        await relayCommand(session, '/effort current').catch((error: unknown) => error),
        why,
      ).toBeNull()
    },
  )

  it('gives up on a relay that never answers, and starts anyway [fence:startup-self-check-relay-under-the-deadline]', async () => {
    const why =
      'The effort relay must race the same deadline as the Turn, and the deadline must resolve ' +
      'it to a disagreement rather than reject (#110, ADR-0016). Outside the timeout, a probe ' +
      'that answers the Turn and then goes quiet holds boot open for ever; rejected, a prose ' +
      'disagreement becomes a refusal to boot — an outage over thinking at the wrong depth.'
    vi.useFakeTimers()
    try {
      const { log, check } = selfCheck({ timeoutMs: 1_000, effortAnswer: null })
      let settled = false
      const outcome = check.finally(() => {
        settled = true
      })
      outcome.catch(() => {})
      await vi.advanceTimersByTimeAsync(2_000)
      expect(settled, why).toBe(true)
      const report = await outcome.catch((error: unknown) =>
        expect.unreachable(`${why}\n${String(error)}`),
      )

      expect(report.apiKeySource, why).toBe('none')
      expect(report.effort, why).toMatchObject({ reported: null, agrees: false })
      expect(log, why).toEqual([
        { event: 'effort-unverified', pinned: PINNED_EFFORT, reported: null },
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
