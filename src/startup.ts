import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEnv, type Credential } from './build-env.js'
import type { ChannelAdapter } from './channel-adapter.js'
import type { SpawnClaudeProcess } from './claude-process.js'
import type { RetryBudget } from './config.js'
import { Core } from './core.js'
import { SessionGenerations } from './session-generation.js'
import { SessionPool, type PoolLog } from './session-pool.js'
import { startupSelfCheck, type StartupSelfCheckReport } from './startup-self-check.js'
import { TaskQueue } from './task-queue.js'

export interface StartRomaOptions {
  /** The credential every Session runs on, and the one the self-check verifies. */
  readonly credential: Credential
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
  /** CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR, both pointed here. */
  readonly configDir?: string
  /** The pinned model. Defaults to the one every Session runs on. */
  readonly model?: string
  readonly maxConcurrentTasks?: number
  readonly retryBudget?: RetryBudget
  readonly spawn?: SpawnClaudeProcess
  readonly log?: PoolLog
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
  channel,
  workRoot,
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
  const env = buildEnv({ credential, ...(configDir === undefined ? {} : { configDir }) })

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

  const pool = new SessionPool({
    workRoot,
    env,
    ...(model === undefined ? {} : { model }),
    ...(retryBudget === undefined ? {} : { retryBudget }),
    ...(spawn === undefined ? {} : { spawn }),
    ...(log === undefined ? {} : { log }),
  })
  const queue = new TaskQueue(
    maxConcurrentTasks === undefined ? {} : { maxConcurrent: maxConcurrentTasks },
  )
  const sessions = new SessionGenerations({ workRoot })

  return {
    core: new Core({ channel, pool, queue, sessions }),
    pool,
    queue,
    sessions,
    selfCheck,
    shutdown: () => pool.shutdown(),
  }
}
