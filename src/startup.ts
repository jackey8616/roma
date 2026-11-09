import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog } from './audit-log.js'
import { buildEnv, type Credential } from './build-env.js'
import { CAVEMAN_OFF } from './caveman.js'
import { PINNED_EFFORT, PINNED_MODEL } from './claude-session.js'
import type { CredentialEnvs } from './session-pool.js'
import type { SpawnClaudeProcess } from './claude-process.js'
import type { RetryBudget } from './config.js'
import { ReachUse } from './reach-use.js'
import { Core, type CoreLogRecord, type CoreOptions } from './core.js'
import { FreshTokens } from './fresh-tokens.js'
import { eachReach, type Reach, type Reaches } from './reach.js'
import type { BoundChannel, ChannelBinding } from './serve.js'
import {
  chosenCavemen,
  chosenEfforts,
  chosenModels,
  SessionGenerations,
} from './session-generation.js'
import type { OperatorLog } from './operator-log.js'
import { SessionPool, type PoolLogRecord } from './session-pool.js'
import { socketPathIn, type CredentialWanted } from './shim-protocol.js'
import {
  ShimServer,
  type ServedReach,
  type ServedReaches,
  type ShimLogRecord,
} from './shim-server.js'
import {
  startupSelfCheck,
  type SelfCheckLogRecord,
  type StartupSelfCheckReport,
} from './startup-self-check.js'
import { TaskQueue } from './task-queue.js'
import { WorkRoot } from './work-root.js'

export interface ShimsOptions {
  readonly dir: string
  readonly gitConfig: string
}

export type ReachLogRecord =
  | {
      readonly event: 'reach'
      readonly credential: CredentialWanted
      readonly account: string | null
    }
  | {
      readonly event: 'reach-token-minted'
      readonly credential: CredentialWanted
      readonly account: string | null
    }

export interface StartRomaOptions {
  readonly credential: Credential
  readonly overflow?: {
    readonly credential: Credential
    readonly monthlyCapUsd: number
  }
  readonly channels: readonly ChannelBinding[]
  readonly workRoot: string
  readonly auditRoot: string
  readonly configDir: string
  readonly reaches: Reaches
  readonly shims: ShimsOptions
  readonly model?: string
  readonly effort?: string
  readonly caveman?: string
  readonly maxConcurrentTasks?: number
  readonly retryBudget?: RetryBudget
  readonly spawn?: SpawnClaudeProcess
  readonly log?: OperatorLog<
    PoolLogRecord | CoreLogRecord | ShimLogRecord | ReachLogRecord | SelfCheckLogRecord
  >
  readonly selfCheckCwd?: string
  readonly selfCheckTimeoutMs?: number
}

export interface Roma {
  readonly channels: readonly BoundChannel[]
  readonly pool: SessionPool
  readonly queue: TaskQueue
  readonly sessions: SessionGenerations
  readonly audit: AuditLog
  readonly selfCheck: StartupSelfCheckReport
  shutdown(): Promise<void>
}

export async function startRoma({
  credential,
  overflow,
  channels,
  workRoot,
  auditRoot,
  configDir,
  reaches,
  shims,
  model,
  effort,
  caveman,
  maxConcurrentTasks,
  retryBudget,
  spawn,
  log,
  selfCheckCwd,
  selfCheckTimeoutMs,
}: StartRomaOptions): Promise<Roma> {
  const proved = new Map<CredentialWanted, string | null>()
  for (const reach of eachReach(reaches)) {
    const { account } = await reach.prove()
    proved.set(reach.credential, account)
    log?.({ event: 'reach', credential: reach.credential, account })
  }

  const pinnedModel = model ?? PINNED_MODEL
  const pinnedEffort = effort ?? PINNED_EFFORT
  const pinnedCaveman = caveman ?? CAVEMAN_OFF

  const env = buildEnv({ credential, configDir })

  const probeCwd = selfCheckCwd ?? mkdtempSync(join(tmpdir(), 'roma-self-check-'))
  let selfCheck: StartupSelfCheckReport
  try {
    selfCheck = await startupSelfCheck({
      credential,
      env,
      cwd: probeCwd,
      ...(model === undefined ? {} : { model }),
      effort: pinnedEffort,
      ...(spawn === undefined ? {} : { spawn }),
      ...(selfCheckTimeoutMs === undefined ? {} : { timeoutMs: selfCheckTimeoutMs }),
      ...(log === undefined ? {} : { log }),
    })
  } finally {
    if (selfCheckCwd === undefined) rmSync(probeCwd, { recursive: true, force: true })
  }

  mkdirSync(shims.dir, { recursive: true, mode: 0o700 })
  const gitConfigPath = join(shims.dir, 'gitconfig')
  writeFileSync(gitConfigPath, shims.gitConfig, { mode: 0o600 })
  const socketPath = socketPathIn(shims.dir)

  const queue = new TaskQueue(
    maxConcurrentTasks === undefined ? {} : { maxConcurrent: maxConcurrentTasks },
  )
  const cloudUse = new ReachUse()
  const documentUse = new ReachUse()
  const shimServer = await ShimServer.listen({
    socketPath,
    reaches: servedReaches(reaches, proved, log),
    onCredential: (taskId, credential) => {
      if (credential === 'cloud') cloudUse.minted(taskId)
      if (credential === 'documents') documentUse.minted(taskId)
    },
    taskFor: (sessionId) => queue.taskFor(sessionId),
    ...(log === undefined ? {} : { log }),
  })

  const sessionEnv = (from: Credential) => (sessionId: string) =>
    buildEnv({
      credential: from,
      configDir,
      shims: { sessionId, socketPath, gitConfigPath },
    })
  const envs: CredentialEnvs = {
    [credential.kind]: sessionEnv(credential),
    ...(overflow === undefined ? {} : { overflow: sessionEnv(overflow.credential) }),
  }

  const work = new WorkRoot(workRoot)

  const models = chosenModels({ workRoot: work, pinnedModel })
  const efforts = chosenEfforts({ workRoot: work, pinnedEffort })
  const cavemen = chosenCavemen({ workRoot: work, pinnedCaveman })

  const pool = new SessionPool({
    workRoot: work,
    envs,
    models,
    efforts,
    cavemen,
    announcements: eachReach(reaches).map((reach) => reach.announce()),
    ...(retryBudget === undefined ? {} : { retryBudget }),
    ...(spawn === undefined ? {} : { spawn }),
    ...(log === undefined ? {} : { log }),
  })
  const sessions = new SessionGenerations({ workRoot: work })
  const audit = new AuditLog({ auditRoot })

  const shared: Omit<CoreOptions, 'channel'> = {
    pool,
    workRoot: work,
    queue,
    sessions,
    models,
    efforts,
    cavemen,
    cavemanPinned: caveman !== undefined,
    audit,
    credential: credential.kind,
    usedCloudReach: (taskId) => cloudUse.takeUsedBy(taskId),
    usedDocumentReach: (taskId) => documentUse.takeUsedBy(taskId),
    ...(overflow === undefined ? {} : { overflow: { monthlyCapUsd: overflow.monthlyCapUsd } }),
    ...(log === undefined ? {} : { log }),
  }

  return {
    channels: channels.map((binding) =>
      binding.coreOver((channel) => new Core({ channel, ...shared })),
    ),
    pool,
    queue,
    sessions,
    audit,
    selfCheck,
    shutdown: async () => {
      try {
        await pool.shutdown()
      } finally {
        await shimServer.close()
      }
    },
  }
}

function servedReaches(
  reaches: Reaches,
  proved: ReadonlyMap<CredentialWanted, string | null>,
  log: OperatorLog<ReachLogRecord> | undefined,
): ServedReaches {
  const served = (reach: Reach): ServedReach => {
    if (!('minter' in reach)) return { unavailable: reach.unavailable }
    const account = proved.get(reach.credential) ?? null
    return {
      account,
      tokens: new FreshTokens({
        minter: reach.minter,
        onMint: () => log?.({ event: 'reach-token-minted', credential: reach.credential, account }),
      }),
    }
  }

  return {
    code: served(reaches.code),
    cloud: served(reaches.cloud),
    documents: served(reaches.documents),
  }
}
