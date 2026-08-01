import { randomUUID } from 'node:crypto'
import { apiKeySourceFor, type Credential } from './build-env.js'
import type { SpawnClaudeProcess } from './claude-process.js'
import { ClaudeSession, PINNED_EFFORT, PINNED_MODEL, TurnFailedError } from './claude-session.js'
import { writeToStderr, type OperatorLog } from './operator-log.js'
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
 * The command roma relays to the probe once the Turn has passed.
 *
 * Claude Code's own `/effort`, sent as itself rather than as prose. It is the
 * only place in roma that asks a process about effort, and it is asked once per
 * deployment rather than once per spawn — measured at `num_turns: 0`,
 * `total_cost_usd: 0`, and answered with no credential at all.
 *
 * **Deliberately not named a Readout.** CONTEXT.md's entry for that term lists
 * `/effort` under what it must never be used for: a Readout is something roma
 * relays *on a Caller's behalf, to their Session*, and `/effort` is roma's own
 * Command precisely so that it never reaches one. This is a boot probe asking a
 * throwaway process about itself, with no Caller, no Session anybody is on and
 * no Task — which is why `relayCommand` describes itself by subtraction.
 */
const EFFORT_QUESTION = '/effort current'

/**
 * The word roma's Pinned Effort is never allowed to be, however the sentence is
 * worded around it.
 *
 * The build says `Effort level: auto (currently high)` when nothing pinned one —
 * which contains `high`, and would therefore satisfy a bare level-word match on
 * the default deployment. Since roma always passes `--effort`, an `auto` in the
 * answer is the wiring failure this check exists to catch, wearing the level's
 * own clothes.
 */
const UNPINNED = 'auto'

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
 * The one thing this check notices and does not refuse over.
 *
 * Every other condition here reads a structured field — `apiKeySource`, `model`,
 * `num_turns`. This one reads English prose in at least three shapes, one of
 * which embeds a description table, and none of it is in `system/init` because
 * `system/init` carries no effort field at all. Making a deployment refuse to
 * start on a sentence a release could reword is paying with an outage to catch a
 * fault whose worst outcome is thinking at the wrong depth (ADR-0016).
 *
 * So it goes to the Operator Log, which is where an anomaly goes — ADR-0012's
 * drift check already writes a misbehaving Readout there for the same reason. And
 * the match is loose so the line fires on a changed *level* rather than on
 * changed *prose*, because a check people learn to ignore has stopped watching.
 *
 * `reported` is what the process said, whole, and null where it said nothing at
 * all — a relay that failed is a disagreement roma cannot resolve rather than an
 * agreement it may assume.
 */
export type SelfCheckLogRecord = {
  readonly event: 'effort-unverified'
  readonly pinned: string
  readonly reported: string | null
}

export type SelfCheckLog = OperatorLog<SelfCheckLogRecord>

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
  /**
   * The effort roma pins. Defaults to the one every Session runs at.
   *
   * Spawned with, and then asked about — which is the whole of what this proves.
   * It is **roma's own wiring** under test rather than Claude Code's: that
   * `--effort` really is in the spawn arguments, and that `ROMA_EFFORT` really
   * resolved to what roma thinks. Per-spawn verification was decided and then
   * withdrawn once the precedence measurements came in, since `--effort` beats
   * the settings file and `buildEnv` blocks the environment variable, leaving a
   * per-spawn echo nothing to catch but a server-side ceiling nobody has ever
   * observed (ADR-0016).
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
  /**
   * What the process said when asked what effort it is at, and whether roma
   * believes it.
   *
   * Reported rather than asserted, and typed as the two facts rather than as one
   * boolean, because a boot log that said only "disagreed" would send an operator
   * to read a sentence that is no longer anywhere. `reported` is null where the
   * relay itself did not answer.
   */
  readonly effort: {
    readonly pinned: string
    readonly reported: string | null
    readonly agrees: boolean
  }
  readonly durationMs: number
  /**
   * What proving this cost. Small, and it is spent on every boot.
   *
   * Null if the probe's terminal event carried no total, which would itself be
   * news — every capture we hold has one — and is reported rather than smoothed
   * to zero for the same reason an Audit Record is: a boot that says it cost
   * nothing and a boot that could not tell are different things to read.
   */
  readonly costUsd: number | null
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
  effort = PINNED_EFFORT,
  spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = writeToStderr,
}: StartupSelfCheckOptions): Promise<StartupSelfCheckReport> {
  const session = new ClaudeSession({
    // Its own Session, used once and never resumed. Nothing roma serves is on
    // it, so a probe Turn cannot land in anybody's context.
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
    // A Turn that completed without one means the field both assertions are made
    // on was never in the stream. Silence here would be a self-check that passes
    // by having checked nothing.
    const { init } = reported
    if (init === null) throw new StartupSelfCheckFailed([noInit()])
    // Last, and after both assertions, because it is the only condition here
    // that does not block. Everything that can refuse the boot has refused by
    // now, so nothing below can turn a disagreement about prose into an outage.
    //
    // Under the same deadline the Turn was, and spending it differently. `send`
    // settles on a stream result or on the process dying, so a probe that
    // answered the Turn and then never answers this would hold the boot open for
    // ever — the one condition designed never to block would be the only one
    // outside the timeout, and a check that exists to stop a hang would have
    // become one. It must not *refuse* on the deadline either, so the deadline
    // resolves this to null, which reads as a disagreement roma cannot resolve
    // exactly as a failed relay does. Whatever the Turn left of the budget is
    // what this gets, which is the right way round: the deadline is how long roma
    // will spend booting, not how long each exchange may take.
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

/**
 * Relay one of Claude Code's own commands to a process and hand back what it
 * said, or null if it did not say anything.
 *
 * The gesture `Core.#runReadout` makes, with everything that makes a Readout a
 * Readout taken away: no Caller, so no Caller Marker; no Task, so no queue, no
 * concurrency slot and no acknowledgement; no Audit Record, because nobody was
 * billed and nobody asked. What is left is the primitive itself — one command
 * onto stdin as itself, one Turn's worth of waiting, and the text back.
 *
 * A named function rather than four lines inline, so that the second caller —
 * whenever there is one — finds this rather than reinventing it beside it. There
 * is no second caller today, and that is worth saying out loud: it is written as
 * a primitive on the strength of what it is, not on the strength of a plan.
 *
 * **Null rather than a throw**, because the only caller must not fail on it. A
 * process that cannot answer a free local command has something wrong with it, and
 * saying so in the Operator Log is the whole of what roma does about that.
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
 * Whether an answer names the effort roma pinned, read loosely.
 *
 * The level word anywhere in the message, case-insensitively, rather than the
 * sentence's shape — which is the point: the build answers this in at least
 * three shapes (`Current effort level: high`, `Effort level: auto (currently
 * high)`, and `ultracode`'s, which embeds a parenthetical description), and a
 * check that matched one of them would fire on a release that reworded it. What
 * it must fire on is a changed *level*.
 *
 * Word boundaries rather than a substring, because `high` is inside `xhigh` and
 * a bare `includes` would have a Session pinned at `high` accept an answer of
 * `xhigh`.
 *
 * **`auto` disagrees with everything, and that is stricter than ADR-0016 wrote
 * down.** The ADR asks for the level word anywhere in the message; this adds one
 * word that vetoes. It is here because the loose rule alone proves nothing for
 * the commonest deployment there is: `Effort level: auto (currently high)` is
 * what the build says when nothing pinned an effort, it contains `high`, and
 * `high` is the Pinned Effort of everybody who has not set `ROMA_EFFORT` — so a
 * bare level-word match would pass in exactly the case the check exists to catch,
 * `--effort` missing from the spawn arguments altogether.
 *
 * The cost is a false disagreement if a release ever writes something like
 * `Current effort level: high (auto-selected)`, which is the prose-brittleness
 * the loose match was chosen to avoid. Taken deliberately, because the two
 * mistakes are not the same size: a false disagreement is one line in the
 * Operator Log on a boot that continues, and a false agreement is roma believing
 * it verified its own wiring when it verified nothing.
 */
export function reportsEffort(message: string, effort: string): boolean {
  if (names(message, UNPINNED)) return false
  return names(message, effort)
}

/** Whether a word appears in a message, on its own and in any casing. */
function names(message: string, word: string): boolean {
  // Escaped because a level is a plain word today and a regular expression is
  // not the place to assume that stays true.
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message)
}

function checkInit(
  init: SystemInit,
  credential: Credential,
  model: string,
): SelfCheckFailure[] {
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
