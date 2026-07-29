import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog } from './audit-log.js'
import { buildEnv, type Credential } from './build-env.js'
import type { CredentialEnvs } from './session-pool.js'
import type { ChannelAdapter } from './channel-adapter.js'
import type { SpawnClaudeProcess } from './claude-process.js'
import type { RetryBudget } from './config.js'
import { Core, type CoreLogRecord } from './core.js'
import { SessionGenerations } from './session-generation.js'
import type { OperatorLog } from './operator-log.js'
import { SessionPool, type PoolLogRecord } from './session-pool.js'
import { startupSelfCheck, type StartupSelfCheckReport } from './startup-self-check.js'
import { TaskQueue } from './task-queue.js'

export interface StartRomaOptions {
  /** The credential every Session runs on, and the one the self-check verifies. */
  readonly credential: Credential
  /**
   * Metered billing, and the ceiling on it. Omitted, roma has no Overflow: a
   * blocked Task waits for the window and is never offered a way past it.
   *
   * The credential and the cap together, because neither is any use without the
   * other. A key with no cap makes ADR-0002's "off by default" ceremony rather
   * than protection; a cap with no key caps nothing. Requiring them as one
   * object is how a deployment cannot configure half of it.
   *
   * **The self-check does not verify this credential.** It drives a real Turn,
   * which on a metered key costs metered money at every boot — so the first
   * thing to find out whether the key works is the first Task somebody takes
   * Overflow on. Worth knowing when one fails.
   */
  readonly overflow?: {
    readonly credential: Credential
    readonly monthlyCapUsd: number
  }
  /**
   * The Channel roma answers on.
   *
   * One, because roma has one. A second Channel means a second Core over this
   * same pool and queue — the Core's own contract already says so — and the
   * shape of that is a change to make when there is a second Adapter to make it
   * against, not machinery to build now against a Channel that does not exist.
   *
   * Passed in rather than built here: constructing a Channel Adapter needs that
   * Channel's own API client and its own credentials, which is the deployment's
   * business and not roma's.
   */
  readonly channel: ChannelAdapter
  /** Where Sessions get their working directories, one each. */
  readonly workRoot: string
  /**
   * Where the Audit Records go, one file per calendar month.
   *
   * Required, and deliberately not defaulted to somewhere under `workRoot`: that
   * tree is walked by a reclaim that deletes what nothing has touched for seven
   * days, and a default that quietly landed there would delete the log over a
   * quiet week. A deployment naming a durable path is the whole of what makes
   * "records survive a restart" true, and it is not something to be guessed at
   * on a deployment's behalf — the number in these files is the only record of
   * who spent what, and it cannot be reconstructed after the fact.
   */
  readonly auditRoot: string
  /**
   * CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR, both pointed here.
   *
   * Required, for two promises that would otherwise be conditional on a
   * deployment remembering it. It is what keeps a Session's credential
   * resolution off the host's keychain (ADR-0002), and it is where Claude Code
   * writes the Transcript — which ADR-0005 makes the only record there is of
   * what an agent did, on the strength of it living somewhere roma named.
   */
  readonly configDir: string
  /** The pinned model. Defaults to the one every Session runs on. */
  readonly model?: string
  readonly maxConcurrentTasks?: number
  readonly retryBudget?: RetryBudget
  readonly spawn?: SpawnClaudeProcess
  /**
   * Where everything roma does that is an operator's business goes — the pool's
   * and the Core's alike.
   *
   * One log rather than one per component: they describe the same running
   * system, and an operator reading a credential swap wants the refusal that
   * prompted it on the same lines.
   */
  readonly log?: OperatorLog<PoolLogRecord | CoreLogRecord>
  /**
   * Where the self-check's probe Session runs. A throwaway directory by default,
   * removed once the check is done.
   *
   * Deliberately not under `workRoot`: everything there is a Session's, and the
   * probe is not a Session roma serves.
   */
  readonly selfCheckCwd?: string
  readonly selfCheckTimeoutMs?: number
}

/** roma, running. */
export interface Roma {
  readonly core: Core
  readonly pool: SessionPool
  readonly queue: TaskQueue
  readonly sessions: SessionGenerations
  /** Every Task roma has run, and what each one cost. */
  readonly audit: AuditLog
  /** What the self-check found, for the boot log. */
  readonly selfCheck: StartupSelfCheckReport
  /** End every resident process. Sessions keep their context on disk. */
  shutdown(): Promise<void>
}

/**
 * Start roma: verify the credential, then build everything that runs on it.
 *
 * The order is the point, and it is enforced by construction rather than by
 * convention. Nothing that can accept an ingress message exists until the
 * self-check has passed — a boot that fails the check throws from here having
 * built no pool, no queue and no Core, so there is nothing for a message to
 * arrive at and no way to start serving one by accident. "Failure blocks
 * startup" is therefore not a rule anybody has to remember to obey.
 *
 * It is otherwise deliberately thin. Its only other decision is *ownership* —
 * the pool, the queue and the generation record are built here rather than by
 * the Core that uses them, because every cap and rule they carry is roma-wide,
 * and a Core that made its own would quietly turn each of them into one per
 * Channel the day a second Channel arrives.
 */
export async function startRoma({
  credential,
  overflow,
  channel,
  workRoot,
  auditRoot,
  configDir,
  model,
  maxConcurrentTasks,
  retryBudget,
  spawn,
  log,
  selfCheckCwd,
  selfCheckTimeoutMs,
}: StartRomaOptions): Promise<Roma> {
  // Built once and handed to both the check and the pool, so that what was
  // verified is the environment roma actually runs on rather than one built the
  // same way and hoped to be identical.
  const env = buildEnv({ credential, configDir })

  const probeCwd = selfCheckCwd ?? mkdtempSync(join(tmpdir(), 'roma-self-check-'))
  let selfCheck: StartupSelfCheckReport
  try {
    selfCheck = await startupSelfCheck({
      credential,
      env,
      cwd: probeCwd,
      ...(model === undefined ? {} : { model }),
      ...(spawn === undefined ? {} : { spawn }),
      ...(selfCheckTimeoutMs === undefined ? {} : { timeoutMs: selfCheckTimeoutMs }),
    })
  } finally {
    // Ours to clean up only if it was ours to create.
    if (selfCheckCwd === undefined) rmSync(probeCwd, { recursive: true, force: true })
  }

  // One environment per credential a Turn can be paid for by. Overflow is not a
  // mode roma is put into — ADR-0002 makes it exactly this, a different map —
  // and the pool picks between them per Turn.
  const envs: CredentialEnvs = {
    [credential.kind]: env,
    ...(overflow === undefined
      ? {}
      : { overflow: buildEnv({ credential: overflow.credential, configDir }) }),
  }

  const pool = new SessionPool({
    workRoot,
    envs,
    ...(model === undefined ? {} : { model }),
    ...(retryBudget === undefined ? {} : { retryBudget }),
    ...(spawn === undefined ? {} : { spawn }),
    ...(log === undefined ? {} : { log }),
  })
  const queue = new TaskQueue(
    maxConcurrentTasks === undefined ? {} : { maxConcurrent: maxConcurrentTasks },
  )
  const sessions = new SessionGenerations({ workRoot })
  const audit = new AuditLog({ auditRoot })

  return {
    // The credential is handed over as well as the environment built from it,
    // because the record has to say which of the two bills a Task landed on and
    // the environment is a map of secrets rather than an answer to that.
    core: new Core({
      channel,
      pool,
      queue,
      sessions,
      audit,
      credential: credential.kind,
      ...(overflow === undefined ? {} : { overflow: { monthlyCapUsd: overflow.monthlyCapUsd } }),
      ...(log === undefined ? {} : { log }),
    }),
    pool,
    queue,
    sessions,
    audit,
    selfCheck,
    shutdown: () => pool.shutdown(),
  }
}
