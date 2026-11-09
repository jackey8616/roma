import { randomUUID } from 'node:crypto'
import { apiKeySourceFor, type Credential } from './build-env.js'
import type { SpawnClaudeProcess } from './claude-process.js'
import { ClaudeSession, PINNED_EFFORT, PINNED_MODEL, TurnFailedError } from './claude-session.js'
import { writeToStderr, type OperatorLog } from './operator-log.js'
import { readSystemInit, type SystemInit } from './stream-events.js'

const PROBE = 'Reply with OK and nothing else. Do not use any tools.'

const EFFORT_QUESTION = '/effort current'

const UNPINNED = 'auto'

const DEFAULT_TIMEOUT_MS = 60_000

export type SelfCheckCondition = 'credential' | 'model' | 'turn' | 'init' | 'timeout'

export type SelfCheckLogRecord = {
  readonly event: 'effort-unverified'
  readonly pinned: string
  readonly reported: string | null
}

export type SelfCheckLog = OperatorLog<SelfCheckLogRecord>

export interface SelfCheckFailure {
  readonly condition: SelfCheckCondition
  readonly detail: string
  readonly check: string
}

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
  readonly credential: Credential
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly model?: string
  readonly effort?: string
  readonly spawn?: SpawnClaudeProcess
  readonly timeoutMs?: number
  readonly log?: SelfCheckLog
}

export interface StartupSelfCheckReport {
  readonly apiKeySource: string | null
  readonly model: string | null
  readonly claudeCodeVersion: string | null
  readonly effort: {
    readonly pinned: string
    readonly reported: string | null
    readonly agrees: boolean
  }
  readonly durationMs: number
  readonly costUsd: number | null
}

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
    sessionId: randomUUID(),
    cwd,
    env,
    model,
    effort,
    ...(spawn === undefined ? {} : { spawn }),
  })

  const startedAt = Date.now()
  const reported: { init: SystemInit | null } = { init: null }

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
    const { init } = reported
    if (init === null) throw new StartupSelfCheckFailed([noInit()])
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
    await session.terminateOrKill()
  }
}

export async function relayCommand(
  session: ClaudeSession,
  command: string,
): Promise<string | null> {
  try {
    const turn = await session.send(command)
    return turn.text
  } catch (error) {
    if (error instanceof TurnFailedError && error.turn.text !== '') return error.turn.text
    return null
  }
}

export function reportsEffort(message: string, effort: string): boolean {
  if (names(message, UNPINNED)) return false
  return names(message, effort)
}

function names(message: string, word: string): boolean {
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
