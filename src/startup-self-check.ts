import { randomUUID } from 'node:crypto'
import { apiKeySourceFor, type Credential } from './build-env.js'
import type { SpawnClaudeProcess } from './claude-process.js'
import { ClaudeSession, PINNED_EFFORT, PINNED_MODEL, TurnFailedError } from './claude-session.js'
import { writeToStderr, type OperatorLog } from './operator-log.js'
import { readSystemInit, type SystemInit } from './stream-events.js'

const PROBE = 'Reply with OK and nothing else. Do not use any tools.'

const EFFORT_QUESTION = '/effort current'

/** Enforced by `fence:startup-self-check-auto-vetoes`. */
const UNPINNED = 'auto'

const DEFAULT_TIMEOUT_MS = 60_000

/** Which of the check's conditions was not met. */
export type SelfCheckCondition = 'credential' | 'model' | 'turn' | 'init' | 'timeout'

/**
 * The one thing this check notices and does not refuse over: the effort the
 * probe reports disagreeing with the one roma pinned. Boot continues.
 *
 * `reported` is what the process said, whole, and null where it said nothing
 * at all, which counts as a disagreement.
 */
export type SelfCheckLogRecord = {
  readonly event: 'effort-unverified'
  readonly pinned: string
  readonly reported: string | null
}

export type SelfCheckLog = OperatorLog<SelfCheckLogRecord>

/** One condition that failed, and what to go and look at. Both halves, always. */
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
 * Carries every condition that failed rather than the first. Enforced by
 * `fence:startup-self-check-reports-every-failure`.
 */
export class StartupSelfCheckFailed extends Error {
  readonly failures: readonly SelfCheckFailure[]

  constructor(failures: readonly SelfCheckFailure[]) {
    super(
      ['roma refused to start — the startup self-check failed.']
        .concat(
          failures.map(
            ({ condition, detail, check }) => `  [${condition}] ${detail}\n    ${check}`,
          ),
        )
        .join('\n'),
    )
    this.name = 'StartupSelfCheckFailed'
    this.failures = failures
  }
}

export interface StartupSelfCheckOptions {
  /**
   * The credential roma means to run on, and what the check is measured
   * against: a Shared Window credential must resolve to `apiKeySource: "none"`,
   * an Overflow one to `"ANTHROPIC_API_KEY"`.
   */
  readonly credential: Credential
  /**
   * The environment roma will actually run on, built by `buildEnv`. Pass the
   * same object the pool will use: the check verifies it agrees with
   * `credential`, and catches one built differently or quietly added to.
   */
  readonly env: Readonly<Record<string, string>>
  /**
   * Where the probe runs. Throwaway and its own: project settings in it could
   * change the model out from under the assertion.
   */
  readonly cwd: string
  /** The Pinned Model. Defaults to `PINNED_MODEL`. */
  readonly model?: string
  /**
   * The Pinned Effort. Defaults to `PINNED_EFFORT`. The probe is spawned with
   * it and then asked `/effort current`.
   */
  readonly effort?: string
  readonly spawn?: SpawnClaudeProcess
  readonly timeoutMs?: number
  /** Where a disagreement about the effort goes. Boot continues either way. */
  readonly log?: SelfCheckLog
}

/**
 * What the check found, for the boot log.
 *
 * `apiKeySource` and `model` are typed as the stream reports them, but are
 * never null in a returned report: a null fails the check.
 */
export interface StartupSelfCheckReport {
  readonly apiKeySource: string | null
  readonly model: string | null
  /** Recorded, not asserted: the first question when the check starts failing. */
  readonly claudeCodeVersion: string | null
  /**
   * What the process said when asked what effort it is at, and whether roma
   * believes it. Reported, not asserted. `reported` is null where the relay
   * itself did not answer.
   */
  readonly effort: {
    readonly pinned: string
    readonly reported: string | null
    readonly agrees: boolean
  }
  readonly durationMs: number
  /**
   * What proving this cost, spent on every boot. Null, never zero, if the
   * probe's terminal event carried no total.
   */
  readonly costUsd: number | null
}

/**
 * The Startup Self-Check: refuse to start unless auth really resolves to the
 * intended credential on the pinned model. A live `-p` Turn, spawned exactly as
 * roma spawns, costing `costUsd` on every boot.
 *
 * Never `claude auth status`. Enforced by `fence:startup-self-check-probes-with-p`.
 *
 * Every failure throws `StartupSelfCheckFailed`; a wrong credential or model
 * throws at `system/init`, without waiting for the Turn. Always ends the probe
 * process.
 */
export async function startupSelfCheck({
  credential,
  env,
  cwd,
  model = PINNED_MODEL,
  effort = PINNED_EFFORT,
  spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = writeToStderr,
}: StartupSelfCheckOptions): Promise<StartupSelfCheckReport> {
  const session = new ClaudeSession({
    // Enforced by `fence:startup-self-check-probe-is-its-own-session`.
    sessionId: randomUUID(),
    cwd,
    env,
    model,
    // Spawned exactly as roma spawns, which is what makes the relay below a
    // question about roma's real arguments rather than about a probe's.
    effort,
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
    // Enforced by `fence:startup-self-check-refuses-without-init`.
    const { init } = reported
    if (init === null) throw new StartupSelfCheckFailed([noInit()])
    // Enforced by `fence:startup-self-check-relay-under-the-deadline`.
    const reportedEffort = await Promise.race([
      relayCommand(session, EFFORT_QUESTION),
      expired.then<null, null>(
        () => null,
        () => null,
      ),
    ])
    const agrees = reportedEffort !== null && reportsEffort(reportedEffort, effort)
    if (!agrees) log({ event: 'effort-unverified', pinned: effort, reported: reportedEffort })
    return {
      apiKeySource: init.apiKeySource,
      model: init.model,
      claudeCodeVersion: init.claudeCodeVersion,
      effort: { pinned: effort, reported: reportedEffort, agrees },
      durationMs: Date.now() - startedAt,
      costUsd: turn.costUsd,
    }
  } catch (error) {
    if (error instanceof StartupSelfCheckFailed) throw error
    throw new StartupSelfCheckFailed([probeFailed(error)])
  } finally {
    clearTimeout(deadline)
    // Enforced by `fence:startup-self-check-always-ends-the-probe`.
    await session.terminateOrKill()
  }
}

/**
 * Relay one of Claude Code's own commands to a process and hand back what it
 * said, or null if it said nothing. A failed Turn's text is returned where it
 * has one.
 *
 * Not a Relay: no Caller Marker, no Task, no queue slot, no Acknowledgement and
 * no Audit Record. One command onto stdin, one Turn's wait, the text back.
 *
 * Null rather than a throw. Enforced by `fence:startup-self-check-relay-never-throws`.
 */
export async function relayCommand(
  session: ClaudeSession,
  command: string,
): Promise<string | null> {
  try {
    const turn = await session.send(command)
    return turn.text
  } catch (error) {
    // A failed Turn still carries whatever the process managed to say, which is
    // more use to whoever reads the log than roma paraphrasing the failure.
    if (error instanceof TurnFailedError && error.turn.text !== '') return error.turn.text
    return null
  }
}

/**
 * Whether an answer names the effort roma pinned: the level word anywhere in
 * the message, case-insensitively, whatever the sentence's shape.
 *
 * As a whole word. Enforced by `fence:startup-self-check-effort-word-boundaries`.
 *
 * **`auto` anywhere disagrees with everything.** Enforced by
 * `fence:startup-self-check-auto-vetoes`.
 */
export function reportsEffort(message: string, effort: string): boolean {
  if (names(message, UNPINNED)) return false
  return names(message, effort)
}

function names(message: string, word: string): boolean {
  // Escaped because a level is a plain word today and a regular expression is
  // not the place to assume that stays true.
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message)
}

function checkInit(init: SystemInit, credential: Credential, model: string): SelfCheckFailure[] {
  const failures: SelfCheckFailure[] = []
  const expectedSource = apiKeySourceFor(credential.kind)

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
