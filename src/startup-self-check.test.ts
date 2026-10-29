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

/**
 * A Turn that resolves the right credential and then fails to authenticate.
 *
 * The failure nothing cheaper can see. `apiKeySource` and the model are reported
 * before the first API call, so a token that 401s produces a perfectly healthy
 * `system/init` — which is why the check drives the Turn to completion rather
 * than stopping there.
 */
const DEAD_TOKEN = [...OK.slice(0, -1), ...FAILED.slice(-1)]

/** A Turn that failed having said nothing at all. */
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

/** The same recorded Turn with `system/init` saying something else. */
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
  /** The stream the probe process answers with. Null means it answers nothing. */
  readonly events?: readonly ClaudeEvent[] | null
  /**
   * What the process answers the relayed `/effort current` with. Null means it
   * answers nothing at all, which is a disagreement roma cannot resolve.
   *
   * Defaults to agreeing, so that every test about something else is not also a
   * test about the effort.
   */
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
  // Attached now rather than by the chain below, which does not adopt this
  // promise until the feeding has finished. A check that refuses at
  // `system/init` rejects before the second answer is even sent, and in that
  // window it would otherwise be an unhandled rejection. The tests still await
  // the real thing.
  check.catch(() => {})

  // Fed after the check has started, the way a real process answers: there is
  // nothing to write to until the spawn has happened.
  const answered = flush().then(async () => {
    if (events === null) return
    feed(claude.process, events)
    // And the relay after the probe Turn, because that is the order the check
    // sends them in — nothing is listening for this until the first has settled.
    await flush()
    if (effortAnswer !== null) feed(claude.process, effortAnswer)
  })

  return { claude, log, check: answered.then(() => check) }
}

/** The failed conditions, which is what an operator is actually told. */
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

  // The condition ADR-0002 fears: metered billing, learned about from an
  // invoice.
  //
  // Only the credential fails, and that is the measured shape rather than a
  // convenience. The prototype watched a stray key take the model to
  // `claude-opus-5[1m]` as well, but that run did not pass `--model`; seam 2
  // measured the same stray key against roma's pinned invocation leaving the
  // model at `claude-sonnet-5`. apiKeySource is what gives a stray key away.
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

  // Both conditions at once, off the pre-pinning capture where they really did
  // co-occur. An operator told only about the model would go looking for a
  // config change that never happened.
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

  // The whole point of failing at init rather than at the end of the Turn. This
  // stream stops at system/init and never produces a result, so a check that
  // waited for one would still be waiting.
  it('refuses at system/init without waiting for the Turn', async () => {
    const { check } = selfCheck({
      events: upToFirst(withInit(OK, { apiKeySource: 'ANTHROPIC_API_KEY' }), 'system/init'),
    })

    await expect(check).rejects.toThrow(StartupSelfCheckFailed)
  })

  // Pinning the model is what converts a silent drift into something assertable,
  // so the assertion has to hold on its own — not only as a side effect of the
  // credential being wrong.
  it('fails when the model is not the pinned one, on a credential that is right', async () => {
    const { check } = selfCheck({ events: withInit(OK, { model: 'claude-opus-5[1m]' }) })

    const { failures: failed } = await failures(check)
    expect(failed.map((failure) => failure.condition)).toEqual(['model'])
  })

  // The failure `claude auth status` cannot see, and the reason this check is a
  // live invocation instead of a status query.
  it('fails when the credential resolves correctly but does not work', async () => {
    const { check } = selfCheck({ events: DEAD_TOKEN })

    const { failures: failed } = await failures(check)
    expect(failed.map((failure) => failure.condition)).toEqual(['turn'])
    // Claude Code's own sentence, which is more use than anything roma could
    // write about it.
    expect(failed[0]?.detail).toContain('401')
  })

  // A boot that stops with "self-check failed" names none of three unrelated
  // causes, and this check exists precisely because they are otherwise silent.
  it('says which condition failed and what to go and look at', async () => {
    const { check } = selfCheck({ events: STRAY_KEY })

    const error = await failures(check)
    expect(error.message).toContain('apiKeySource is "ANTHROPIC_API_KEY", expected "none"')
    expect(error.message).toContain('CLAUDE_CONFIG_DIR')
    expect(error.failures.every((failure) => failure.check !== '')).toBe(true)
  })

  // Nothing answered at all: Claude Code missing, or a credential retrying for
  // the three minutes the prototype measured. Either way the boot has to end.
  it('fails rather than waiting forever when nothing answers', async () => {
    const { check } = selfCheck({ events: null, timeoutMs: 5 })

    const { failures: failed } = await failures(check)
    expect(failed.map((failure) => failure.condition)).toEqual(['timeout'])
  })

  // The timeout exists so that a boot cannot hang, so the timeout must not hang
  // either — and ending the probe is where it would. A process that ignores
  // SIGTERM is the one case the deadline was written for, and waiting on its
  // exit is an unbounded wait holding a decision that has already been made.
  it('gives up on a probe process that ignores SIGTERM [fence:startup-self-check-always-ends-the-probe]', async () => {
    const why =
      'The self-check must end its probe with terminateOrKill, never a bare terminate (#27). ' +
      'The path that most needs the probe gone is the deadline, and a process that blew the ' +
      'deadline is exactly the one that may not answer SIGTERM: waiting on its exit holds the ' +
      'refusal behind an unbounded wait and turns the check that exists to stop a hang into one.'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { claude, check } = selfCheck({ events: null, timeoutMs: 5_000 })
      // Waited on before the clock moves: the refusal lands mid-advance, and a
      // rejection nobody is holding yet is an unhandled one.
      const refused = failures(check)
      await flush()
      claude.process.ignore('SIGTERM')

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(TERMINATE_GRACE_MS)

      // Asked before the refusal is awaited: a check that never escalates never
      // refuses either.
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

  // Probing with a different invocation than roma runs would check the wrong
  // thing — a `-p` default change to `--bare` is one of the degradations this
  // exists to catch, and it is only visible to an invocation that looks like
  // roma's.
  //
  // The absent `auth` is the acceptance criterion that `claude auth status` is
  // never used: it reports `loggedIn: true` for any non-empty string, including
  // a token that fails with 401 on first use, so it is the obvious thing to
  // reach for the day someone decides this check is too slow to run at boot —
  // and it would pass in exactly the case that costs a morning to diagnose.
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

  // A probe process left behind would hold a Session nobody will ever send to —
  // and on the failing path, one roma has just decided it does not trust.
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

/**
 * The one condition the check notices and does not refuse over.
 *
 * `--effort` is echoed nowhere in the stream — `system/init` carries no effort
 * field at all — so unlike every other assertion here this one reads English
 * prose, in three shapes, one of which embeds a description table. Refusing a
 * boot on a sentence a release could reword is paying with an outage to catch a
 * fault whose worst outcome is thinking at the wrong depth (ADR-0016).
 *
 * What it proves is **roma's own wiring**: that `--effort` really is in the spawn
 * arguments and `ROMA_EFFORT` really resolved to what roma thinks. Per-spawn
 * verification was decided and then withdrawn on measurement — `--effort` beats
 * the settings file and `buildEnv` blocks the environment variable, so a
 * per-spawn echo has nothing left to catch but a server-side ceiling nobody has
 * ever observed.
 */
describe('what the probe says about its effort', () => {
  it('spawns at the effort roma pinned, and relays a command to ask about it', async () => {
    const { claude, check } = selfCheck({ effort: 'max', effortAnswer: EFFORT_ANSWERS.at('max') })
    await check

    const args = claude.lastSpawn.args
    expect(args[args.indexOf('--effort') + 1]).toBe('max')
    // As itself, over stdin, with no Caller Marker above it — a relay rather
    // than a Task. This is the only place in roma that asks a process about
    // effort, and it happens once per deployment.
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
    // The Operator Log is what roma decided and what surprised it. A line per
    // boot that agreed would make it a traffic log, which is what a check people
    // learn to ignore looks like on the way to having stopped watching.
    expect(log).toEqual([])
  })

  // The whole point of a loose match: the level word anywhere in the message,
  // rather than the sentence's shape. `ultracode` answers with a parenthetical
  // description attached and still agrees.
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

    // Started. That is the assertion — everything else here is what an operator
    // is told on the way past.
    expect(report.apiKeySource).toBe('none')
    expect(report.effort).toMatchObject({ pinned: 'max', agrees: false })
    expect(log).toEqual([
      { event: 'effort-unverified', pinned: 'max', reported: expect.stringContaining('low') },
    ])
  })

  /**
   * The hole a bare level-word match leaves, and the reason `auto` disagrees
   * with everything.
   *
   * `Effort level: auto (currently high)` is what the build says when nothing
   * pinned an effort — and it contains `high`, which is the Pinned Effort of
   * every deployment that has not set `ROMA_EFFORT`. Matching on the level alone
   * would have this check pass in exactly the case it exists to catch: `--effort`
   * missing from the spawn arguments altogether.
   */
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

  // `high` is inside `xhigh`, so a substring match would have a deployment
  // pinned at `high` accept a process reporting `xhigh`.
  it('does not read xhigh as high [fence:startup-self-check-effort-word-boundaries]', () => {
    const why =
      'The pinned level must be matched as a whole word, not a substring (#110): `high` is ' +
      'inside `xhigh`, so a Session pinned at high would accept an answer of xhigh.'
    expect(reportsEffort('Current effort level: xhigh', 'high'), why).toBe(false)
    expect(reportsEffort('Current effort level: xhigh', 'xhigh'), why).toBe(true)
  })

  // A relay that failed is a disagreement roma cannot resolve rather than an
  // agreement it may assume — and it is still not a refusal, because a process
  // that cannot answer a free local command has failed nothing the boot depends
  // on.
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

  /**
   * The relay is under the same deadline the Turn was, and it must be.
   *
   * `send` settles on a stream result or on the process dying, so a probe that
   * answers the Turn and then goes quiet has nothing to end this. Left outside
   * the timeout, the one condition designed never to block would be the only one
   * that could block for ever — and the check whose whole purpose is that a boot
   * cannot hang would have become the hang.
   *
   * It expires to a disagreement rather than to a refusal, because "boot
   * continues" is the decision (ADR-0016) and a process too slow to answer a free
   * local command has failed nothing the boot depends on.
   */
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
      // Past the deadline, with the relay still outstanding. Without the race
      // this promise never settles, which is the hang this test exists for.
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
