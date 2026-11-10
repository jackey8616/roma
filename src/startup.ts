import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AuditLog } from './audit-log.js'
import { buildEnv, type Credential } from './build-env.js'
import { CAVEMAN_OFF } from './caveman.js'
import { PINNED_EFFORT, PINNED_MODEL } from './claude-session.js'
import type { CredentialEnvs } from './session-pool.js'
import type { RetryBudget } from './config.js'
import { ReachUse } from './reach-use.js'
import { Core, type CoreLogRecord, type CoreOptions } from './core.js'
import { CredentialProxy, type Fronted } from './credential-proxy.js'
import { allows } from './egress/allowlist.js'
import { EgressProxy, type Gateway } from './egress/egress-proxy.js'
import { FreshTokens } from './fresh-tokens.js'
import { IsolationRefused, isolating, realLauncher, type Launcher } from './launcher.js'
import type { SeatOutcome, SpawnRuntimeProcess } from './runtime-process.js'
import { moveTranscripts } from './transcript-move.js'
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
import { seatSocketPathIn, type CredentialWanted } from './shim-protocol.js'
import { SEATS, SELF_CHECK_SEAT } from './seats.js'
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

export type IsolationLogRecord = {
  readonly event: 'transcripts-moved'
  readonly moved: number
  readonly unattributed: readonly string[]
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
  readonly launcher?: Launcher
  readonly log?: OperatorLog<
    | PoolLogRecord
    | CoreLogRecord
    | ShimLogRecord
    | ReachLogRecord
    | SelfCheckLogRecord
    | IsolationLogRecord
  >
  readonly selfCheckTimeoutMs?: number
  readonly anthropicApi?: string
  readonly egress?: EgressOptions
}

export interface EgressOptions {
  readonly gateway: Gateway
  readonly allow: readonly string[]
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

export async function startRoma(options: StartRomaOptions): Promise<Roma> {
  const { anthropicApi, egress } = options
  const proxy = await CredentialProxy.listen({
    ...(anthropicApi === undefined ? {} : { upstream: anthropicApi }),
    ...(egress === undefined ? {} : { via: egress.gateway }),
  })
  let agentEgress: EgressProxy | null = null
  try {
    if (egress !== undefined) {
      agentEgress = await EgressProxy.listen({ allow: allows(egress.allow), via: egress.gateway })
    }
    return await startBehind(proxy, agentEgress, options)
  } catch (error) {
    await agentEgress?.close()
    await proxy.close()
    throw error
  }
}

async function startBehind(
  proxy: CredentialProxy,
  agentEgress: EgressProxy | null,
  {
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
    launcher = realLauncher(),
    log,
    selfCheckTimeoutMs,
  }: StartRomaOptions,
): Promise<Roma> {
  const proved = new Map<CredentialWanted, string | null>()
  for (const reach of eachReach(reaches)) {
    const { account } = await reach.prove()
    proved.set(reach.credential, account)
    log?.({ event: 'reach', credential: reach.credential, account })
  }

  const pinnedModel = model ?? PINNED_MODEL
  const pinnedEffort = effort ?? PINNED_EFFORT
  const pinnedCaveman = caveman ?? CAVEMAN_OFF

  const fronted = proxy.front(credential)
  const egressProxy = agentEgress === null ? {} : { egressProxy: agentEgress.url }
  const env = buildEnv({ credential: fronted, configDir, ...egressProxy })

  for (const [root, mode] of [
    [workRoot, 0o711],
    [configDir, 0o711],
    [auditRoot, 0o700],
  ] as const) {
    mkdirSync(root, { recursive: true, mode })
    chmodSync(root, mode)
  }
  const transcripts = moveTranscripts({ configDir, workRoot })
  if (transcripts.moved.length > 0 || transcripts.unattributed.length > 0) {
    log?.({
      event: 'transcripts-moved',
      moved: transcripts.moved.length,
      unattributed: transcripts.unattributed,
    })
  }
  await isolating('sweep every Seat and park every Session', () => launcher.sweep())

  const work = new WorkRoot(workRoot, (sessionId) => launcher.reclaim(sessionId))

  const probe = randomUUID()
  let probeEnded: Promise<SeatOutcome | undefined> = Promise.resolve(undefined)
  const probeSpawn: SpawnRuntimeProcess = (request) => {
    const process = launcher.spawn({
      ...request,
      seat: { seat: SELF_CHECK_SEAT, sessionId: probe },
    })
    probeEnded = new Promise((ended) => {
      process.onExit((exit) => ended(exit.seat))
      process.onError(() => ended(undefined))
    })
    return process
  }
  let selfCheck: StartupSelfCheckReport | null = null
  let selfCheckFailed: unknown = null
  try {
    selfCheck = await startupSelfCheck({
      credential,
      env,
      cwd: work.sessionDir(probe),
      ...(model === undefined ? {} : { model }),
      effort: pinnedEffort,
      spawn: probeSpawn,
      ...(selfCheckTimeoutMs === undefined ? {} : { timeoutMs: selfCheckTimeoutMs }),
      ...(log === undefined ? {} : { log }),
    })
  } catch (error) {
    selfCheckFailed = error
  }
  const probeSeat = await probeEnded
  if (probeSeat?.returned === false) {
    throw new IsolationRefused([
      `the Startup Self-Check's Seat could not be emptied after it: ${probeSeat.reason}`,
    ])
  }
  await launcher.reclaim(probe).catch(() => {})
  if (selfCheckFailed !== null || selfCheck === null) throw selfCheckFailed

  mkdirSync(shims.dir, { recursive: true, mode: 0o711 })
  chmodSync(shims.dir, 0o711)
  const gitConfigPath = join(shims.dir, 'gitconfig')
  writeFileSync(gitConfigPath, shims.gitConfig, { mode: 0o644 })
  chmodSync(gitConfigPath, 0o644)

  const queue = new TaskQueue(
    maxConcurrentTasks === undefined ? {} : { maxConcurrent: maxConcurrentTasks },
  )
  const cloudUse = new ReachUse()
  const documentUse = new ReachUse()
  const served = servedReaches(reaches, proved, log)
  const holders: { pool: SessionPool | null } = { pool: null }
  const shimServers: ShimServer[] = []
  for (let seat = 0; seat < SEATS; seat++) {
    shimServers.push(
      await ShimServer.listen({
        socketPath: seatSocketPathIn(shims.dir, seat),
        reaches: served,
        onCredential: (taskId, credential) => {
          if (credential === 'cloud') cloudUse.minted(taskId)
          if (credential === 'documents') documentUse.minted(taskId)
        },
        taskFor: (sessionId) => queue.taskFor(sessionId),
        holder: () => holders.pool?.sessionOn(seat) ?? null,
        lease: () => holders.pool?.leaseOn(seat) ?? null,
        ...(log === undefined ? {} : { log }),
      }),
    )
  }
  try {
    await isolating('give each Seat its own Credential Shim socket', () =>
      launcher.handOutSockets(),
    )
  } catch (error) {
    await Promise.all(shimServers.map((server) => server.close()))
    throw error
  }

  const sessionEnv = (from: Fronted) => (sessionId: string, seat: number) =>
    buildEnv({
      credential: from,
      configDir,
      shims: { sessionId, socketPath: seatSocketPathIn(shims.dir, seat), gitConfigPath },
      ...egressProxy,
    })
  const envs: CredentialEnvs = {
    [credential.kind]: sessionEnv(fronted),
    ...(overflow === undefined ? {} : { overflow: sessionEnv(proxy.front(overflow.credential)) }),
  }

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
    spawn: launcher.spawn,
    launcher,
    ...(log === undefined ? {} : { log }),
  })
  holders.pool = pool
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
        await Promise.all(shimServers.map((server) => server.close()))
        await agentEgress?.close()
        await proxy.close()
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
