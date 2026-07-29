import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEnv, type Credential } from './build-env.js'
import { TERMINATE_GRACE_MS } from './claude-session.js'
import { startupSelfCheck, StartupSelfCheckFailed } from './startup-self-check.js'
import type { ClaudeEvent } from './stream-events.js'
import { FakeClaude, flush } from '../test/support/fake-claude.js'
import { feed, recordedStream, upToFirst } from '../test/support/recorded-stream.js'

/**
 * A real Turn under the Shared Window credential: `apiKeySource: "none"`,
 * `model: "claude-sonnet-5"`, `is_error: false`. What a boot that should be
 * allowed to proceed looks like.
 */
const HEALTHY = recordedStream('three-turns-one-process').turn(1)
/**
 * A real Turn under a stray `ANTHROPIC_API_KEY` — the capture that gives this
 * check a reason to exist. `apiKeySource: "ANTHROPIC_API_KEY"`, a model silently
 * moved to `claude-opus-5[1m]`, and a 401 arriving as `is_error: true` with
 * `subtype: "success"`.
 */
const STRAY_KEY = recordedStream('auth-failure').turn(1)

/**
 * A Turn that resolves the right credential and then fails to authenticate.
 *
 * The failure nothing cheaper can see. `apiKeySource` and the model are reported
 * before the first API call, so a token that 401s produces a perfectly healthy
 * `system/init` — which is why the check drives the Turn to completion rather
 * than stopping there.
 */
const DEAD_TOKEN = [...HEALTHY.slice(0, -1), ...STRAY_KEY.slice(-1)]

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
  readonly timeoutMs?: number
  /** The stream the probe process answers with. Null means it answers nothing. */
  readonly events?: readonly ClaudeEvent[] | null
}

function selfCheck({ credential = OAUTH, model, timeoutMs, events = HEALTHY }: SelfCheckRun = {}) {
  const claude = new FakeClaude({ exitOnKill: true })
  const cwd = mkdtempSync(join(tmpdir(), 'roma-self-check-'))
  dirs.push(cwd)

  const check = startupSelfCheck({
    credential,
    env: buildEnv({ credential, inherit: {}, configDir: '/work/claude-home' }),
    cwd,
    spawn: claude.spawn,
    ...(model === undefined ? {} : { model }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })

  // Fed after the check has started, the way a real process answers: there is
  // nothing to write to until the spawn has happened.
  const answered = flush().then(() => {
    if (events !== null) feed(claude.process, events)
  })

  return { claude, check: answered.then(() => check) }
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
  it('fails when the credential resolves to an API key instead', async () => {
    const { check } = selfCheck({
      events: upToFirst(withInit(HEALTHY, { apiKeySource: 'ANTHROPIC_API_KEY' }), 'system/init'),
    })

    const { failures: failed } = await failures(check)
    expect(failed.map((failure) => failure.condition)).toEqual(['credential'])
  })

  // Both conditions at once, off the pre-pinning capture where they really did
  // co-occur. An operator told only about the model would go looking for a
  // config change that never happened.
  it('reports every condition that failed, not only the first', async () => {
    const { check } = selfCheck({ events: upToFirst(STRAY_KEY, 'system/init') })

    const { failures: failed } = await failures(check)
    expect(failed.map((failure) => failure.condition)).toEqual(['credential', 'model'])
  })

  // The whole point of failing at init rather than at the end of the Turn. This
  // stream stops at system/init and never produces a result, so a check that
  // waited for one would still be waiting.
  it('refuses at system/init without waiting for the Turn', async () => {
    const { check } = selfCheck({
      events: upToFirst(withInit(HEALTHY, { apiKeySource: 'ANTHROPIC_API_KEY' }), 'system/init'),
    })

    await expect(check).rejects.toThrow(StartupSelfCheckFailed)
  })

  // Pinning the model is what converts a silent drift into something assertable,
  // so the assertion has to hold on its own — not only as a side effect of the
  // credential being wrong.
  it('fails when the model is not the pinned one, on a credential that is right', async () => {
    const { check } = selfCheck({ events: withInit(HEALTHY, { model: 'claude-opus-5[1m]' }) })

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
    const { check } = selfCheck({ events: upToFirst(STRAY_KEY, 'system/init') })

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
  it('gives up on a probe process that ignores SIGTERM', async () => {
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

      const { failures: failed } = await refused
      expect(failed.map((failure) => failure.condition)).toEqual(['timeout'])
      expect(claude.process.signals).toEqual(['SIGTERM', 'SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('expects an API key rather than none under the Overflow credential', async () => {
    const { check } = selfCheck({ credential: OVERFLOW, events: HEALTHY })

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
  it('probes with roma’s own -p invocation, never an auth subcommand', async () => {
    const { claude, check } = selfCheck()
    await check

    expect(claude.lastSpawn.command).toBe('claude')
    expect(claude.lastSpawn.args).toContain('-p')
    expect(claude.lastSpawn.args).not.toContain('auth')
    expect(claude.lastSpawn.args).toEqual(
      expect.arrayContaining(['--model', 'claude-sonnet-5', '--output-format', 'stream-json']),
    )
  })

  // A probe process left behind would hold a Session nobody will ever send to —
  // and on the failing path, one roma has just decided it does not trust.
  it('ends the probe process whether it passed or failed', async () => {
    const passed = selfCheck()
    await passed.check
    const refused = selfCheck({ events: upToFirst(STRAY_KEY, 'system/init') })
    await failures(refused.check)

    expect(passed.claude.process.signals).toContain('SIGTERM')
    expect(refused.claude.process.signals).toContain('SIGTERM')
  })
})

