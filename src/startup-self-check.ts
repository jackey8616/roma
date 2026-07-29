import { randomUUID } from 'node:crypto'
import type { Credential } from './build-env.js'
import type { SpawnClaudeProcess } from './claude-process.js'
import { ClaudeSession, PINNED_MODEL, TurnFailedError } from './claude-session.js'
import { readSystemInit, type SystemInit } from './stream-events.js'

/**
 * The message the probe Turn sends.
 *
 * As small as a Turn can be and still be one. The check needs a *completed*
 * Turn, not merely a started one — `system/init` arrives before the first API
 * call, so a check that stopped there would pass under a token that 401s, which
 * is the exact blind spot `claude auth status` is rejected for.
 */
const PROBE = 'Reply with OK and nothing else. Do not use any tools.'

/**
 * How long roma will wait for the probe Turn before refusing to start.
 *
 * The same minute the retry budget allows a Turn, and for the same reason: a
 * credential that is wrong in a way `system/init` cannot see does not fail
 * fast. It retries — ten times across 182 seconds, in the prototype's capture —
 * and a boot that waits for that is a boot nobody can tell from a hang. Seam 2
 * measured this Turn at 3682ms against a healthy Shared Window, so the budget is
 * about sixteen times what passing actually takes.
 */
const DEFAULT_TIMEOUT_MS = 60_000

/** Which of the check's conditions was not met. */
export type SelfCheckCondition = 'credential' | 'model' | 'turn' | 'init' | 'timeout'

/**
 * One condition that failed, and what to go and look at.
 *
 * Both halves, always. A boot that stops with "self-check failed" tells whoever
 * is standing up roma that something is wrong and nothing about which of three
 * unrelated causes it was — and this check exists precisely because those
 * causes are otherwise silent.
 */
export interface SelfCheckFailure {
  readonly condition: SelfCheckCondition
  /** What was expected, and what the process actually reported. */
  readonly detail: string
  /** Where the cause of that will be. */
  readonly check: string
}

/**
 * The self-check said no, and roma must not start.
 *
 * Carries every condition that failed rather than the first, because they arrive
 * together and they are not independent: a stray key moves `apiKeySource` and
 * can take the model with it, and an operator told only about the model would go
 * looking for a config change that never happened.
 */
export class StartupSelfCheckFailed extends Error {
  readonly failures: readonly SelfCheckFailure[]

  constructor(failures: readonly SelfCheckFailure[]) {
    super(
      ['roma refused to start — the startup self-check failed.']
        .concat(failures.map(({ condition, detail, check }) => `  [${condition}] ${detail}\n    ${check}`))
        .join('\n'),
    )
    this.name = 'StartupSelfCheckFailed'
    this.failures = failures
  }
}

export interface StartupSelfCheckOptions {
  /**
   * The credential roma means to run on.
   *
   * The *intent*, and the whole of what the check is measured against: a
   * Shared Window credential must resolve to `apiKeySource: "none"`, and an
   * Overflow one to `"ANTHROPIC_API_KEY"`.
   */
  readonly credential: Credential
  /**
   * The environment roma will actually run on, built by `buildEnv`.
   *
   * Passed rather than derived from the credential, so that the check verifies
   * the two agree instead of assuming it. An env built from a different
   * credential, or one a deployment has quietly added to, is caught here as the
   * mismatch it is.
   */
  readonly env: Readonly<Record<string, string>>
  /**
   * Where the probe Session runs.
   *
   * Throwaway and its own: a working directory carrying project settings could
   * change the model out from under the very assertion being made here, and
   * roma's own Sessions run in empty directories.
   */
  readonly cwd: string
  /** The model roma pins. Defaults to the one every Session runs on. */
  readonly model?: string
  readonly spawn?: SpawnClaudeProcess
  readonly timeoutMs?: number
}

/**
 * What the check found, for the boot log.
 *
 * `apiKeySource` and `model` are typed as the stream reports them — nullable —
 * rather than as what a passing check implies. They cannot be null in a report
 * that was returned, since a null fails the comparison against a non-null
 * expectation, and substituting a stand-in for a value that cannot occur is how
 * an impossible case acquires a plausible-looking log line.
 */
export interface StartupSelfCheckReport {
  readonly apiKeySource: string | null
  readonly model: string | null
  /**
   * Recorded rather than asserted. Everything the check knows is
   * version-specific, so the day it starts failing, the first question is what
   * changed underneath it.
   */
  readonly claudeCodeVersion: string | null
  readonly durationMs: number
  /** What proving this cost. Small, and it is spent on every boot. */
  readonly costUsd: number
}

/**
 * Refuse to start unless auth really resolves to the intended credential on the
 * pinned model.
 *
 * A live `-p` invocation, made exactly the way roma makes them, driven to a
 * completed Turn. It catches three silent degradations, and the reason it is a
 * real invocation rather than a status query is that each of them is invisible
 * to anything cheaper:
 *
 * - **A stray `ANTHROPIC_API_KEY`.** Metered billing instead of the Shared
 *   Window, learned about from an invoice.
 * - **A model swap.** The model follows the credential, and the invoice from the
 *   first mode is larger than metered billing alone implies.
 * - **A `-p` default change to `--bare`**, which upstream intends: it requires an
 *   API key and would break subscription auth outright.
 *
 * **`claude auth status` cannot serve this purpose.** It reports
 * `loggedIn: true` for any non-empty string, including a token that fails with
 * 401 on first use — so it would wave through the one failure that costs a
 * morning to diagnose.
 *
 * Fails fast where it can. `system/init` carries both assertions and arrives
 * about half a second in, before the first API call, so a wrong credential is
 * refused without waiting for the Turn — seam 2 measured a stray key refused in
 * 1189ms. That matters because a wrong credential is exactly the case that would
 * otherwise retry for three minutes.
 */
export async function startupSelfCheck({
  credential,
  env,
  cwd,
  model = PINNED_MODEL,
  spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: StartupSelfCheckOptions): Promise<StartupSelfCheckReport> {
  const session = new ClaudeSession({
    // Its own Session, used once and never resumed. Nothing roma serves is on
    // it, so a probe Turn cannot land in anybody's context.
    sessionId: randomUUID(),
    cwd,
    env,
    model,
    ...(spawn === undefined ? {} : { spawn }),
  })

  const startedAt = Date.now()
  /**
   * What `system/init` said, once it has said it.
   *
   * A box rather than a plain variable, because it is filled inside the listener
   * below: TypeScript narrows a `let` initialised to null straight back to null
   * at every use after the await, and the value is wanted there.
   */
  const reported: { init: SystemInit | null } = { init: null }

  // Rejects the moment `system/init` disagrees, rather than at the end of a Turn
  // that is not going to arrive.
  const refusedAtInit = new Promise<never>((_, reject) => {
    session.on('event', (event) => {
      const seen = readSystemInit(event)
      if (seen === null || reported.init !== null) return
      reported.init = seen
      const failures = checkInit(seen, credential, model)
      if (failures.length > 0) reject(new StartupSelfCheckFailed(failures))
    })
  })

  let deadline: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    deadline = setTimeout(
      () => reject(new StartupSelfCheckFailed([timedOut(timeoutMs)])),
      timeoutMs,
    )
    deadline.unref?.()
  })

  try {
    session.start()
    const turn = await Promise.race([session.send(PROBE), refusedAtInit, expired])
    // A Turn that completed without one means the field both assertions are made
    // on was never in the stream. Silence here would be a self-check that passes
    // by having checked nothing.
    const { init } = reported
    if (init === null) throw new StartupSelfCheckFailed([noInit()])
    return {
      apiKeySource: init.apiKeySource,
      model: init.model,
      claudeCodeVersion: init.claudeCodeVersion,
      durationMs: Date.now() - startedAt,
      costUsd: turn.costUsd,
    }
  } catch (error) {
    if (error instanceof StartupSelfCheckFailed) throw error
    throw new StartupSelfCheckFailed([probeFailed(error)])
  } finally {
    clearTimeout(deadline)
    // Always, and on every path: a probe process left running would hold a
    // Session nobody will ever send to, and on the failure paths it is a process
    // roma has already decided it does not trust.
    //
    // Escalating to SIGKILL rather than waiting for the exit, because the path
    // that most needs the process gone is the deadline — and a process that blew
    // the deadline is exactly the one that may not answer a SIGTERM either. A
    // plain `terminate` here would hold the refusal behind an unbounded wait and
    // turn the check that exists to stop a hang into one.
    await session.terminateOrKill()
  }
}

/** What `system/init` must say for this credential to be the one in use. */
function expectedApiKeySource(credential: Credential): string {
  return credential.kind === 'shared-window' ? 'none' : 'ANTHROPIC_API_KEY'
}

function checkInit(
  init: SystemInit,
  credential: Credential,
  model: string,
): SelfCheckFailure[] {
  const failures: SelfCheckFailure[] = []
  const expectedSource = expectedApiKeySource(credential)

  if (init.apiKeySource !== expectedSource) {
    failures.push({
      condition: 'credential',
      detail:
        `apiKeySource is ${quote(init.apiKeySource)}, expected ${quote(expectedSource)} ` +
        `for the ${credential.kind} credential`,
      check:
        credential.kind === 'shared-window'
          ? 'an ANTHROPIC_API_KEY is reaching Claude Code — check the environment roma was ' +
            'started with, and CLAUDE_CONFIG_DIR / CLAUDE_SECURESTORAGE_CONFIG_DIR, which are ' +
            'what keep a host keychain login out of it. Left alone this bills to metered API ' +
            'usage rather than the Shared Window.'
          : 'no ANTHROPIC_API_KEY is reaching Claude Code — check that the Overflow key is set ' +
            'in the environment roma was started with.',
    })
  }

  if (init.model !== model) {
    failures.push({
      condition: 'model',
      detail: `model is ${quote(init.model)}, expected the pinned ${quote(model)}`,
      check:
        'the model follows the credential, so this is usually the credential above rather than ' +
        'a config change. If the credential is right, Claude Code is ignoring --model and the ' +
        'invocation in ClaudeSession needs re-verifying against this version.',
    })
  }

  return failures
}

/**
 * A Turn that began correctly and then did not work.
 *
 * The failure `claude auth status` cannot see: `apiKeySource` and the model are
 * reported before the first API call, so a dead token gets all the way to here
 * before anything goes wrong.
 */
function probeFailed(error: unknown): SelfCheckFailure {
  const said =
    error instanceof TurnFailedError && error.turn.text !== ''
      ? error.turn.text
      : error instanceof Error
        ? error.message
        : String(error)
  return {
    condition: 'turn',
    detail: `the probe Turn did not complete: ${said}`,
    check:
      'the credential resolved to the right source but did not work — a 401 here is a token ' +
      'that needs replacing (`claude setup-token`), and note that `claude auth status` would ' +
      'still call it valid. Anything else is Claude Code failing to run at all: check that it ' +
      'is on PATH and that its version still accepts roma’s invocation.',
  }
}

function timedOut(timeoutMs: number): SelfCheckFailure {
  return {
    condition: 'timeout',
    detail: `no completed Turn within ${timeoutMs}ms`,
    check:
      'nothing answered. Either Claude Code is not running at all, or the credential is being ' +
      'retried — a bad one produces api_retry events for around three minutes before the ' +
      'error itself surfaces. The process’s own stderr is where that shows.',
  }
}

function noInit(): SelfCheckFailure {
  return {
    condition: 'init',
    detail: 'the Turn completed but carried no system/init event',
    check:
      'the stream contract has changed: apiKeySource and the model are read from system/init, ' +
      'so without one nothing about this boot has been verified. Re-verify roma’s invocation ' +
      'against the installed Claude Code version before starting it.',
  }
}

function quote(value: string | null): string {
  return value === null ? 'absent' : `"${value}"`
}
