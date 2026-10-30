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

/** roma's own directory, and what roma writes into it. */
export interface ShimsOptions {
  /**
   * roma's own directory: the Credential Shim socket, and the gitconfig every
   * Session runs under.
   *
   * Neither under `workRoot` nor inside a Working Directory. Enforced by
   * `fence:startup-shim-dir-is-roma-own`.
   */
  readonly dir: string
  /**
   * The gitconfig `GIT_CONFIG_GLOBAL` points every Session at, as text. Written
   * as given; the caller composes it.
   */
  readonly gitConfig: string
}

/** What an operator is told about a Reach: once at boot, and per mint. */
export type ReachLogRecord =
  | {
      /**
       * What this deployment reaches on one provider, and which identity it is.
       *
       * Written on every boot for every Reach, including the ones whose answer is
       * "none", after the proof: it is the record of the boot proof, which gets
       * no `reach-token-minted` of its own. Enforced by
       * `fence:startup-reach-line-every-boot`.
       */
      readonly event: 'reach'
      readonly credential: CredentialWanted
      readonly account: string | null
    }
  | {
      /**
       * A credential was minted — not merely asked for, which is usually served
       * from the token roma holds. Written for every Reach.
       */
      readonly event: 'reach-token-minted'
      readonly credential: CredentialWanted
      /** Nullable for the reason the line above is, and never null in practice. */
      readonly account: string | null
    }

export interface StartRomaOptions {
  /** The credential every Session runs on, and the one the self-check verifies. */
  readonly credential: Credential
  /**
   * Metered billing, and the ceiling on it. Omitted, roma has no Overflow: a
   * blocked Task waits for the window and is never offered a way past it.
   *
   * The credential and the cap together, never one without the other. Enforced
   * by `fence:env-overflow-whole-and-roma-own`.
   *
   * **The self-check does not verify this credential**, since a real Turn on it
   * would cost metered money at every boot. The first Task somebody takes
   * Overflow on is the first to find out whether the key works.
   */
  readonly overflow?: {
    readonly credential: Credential
    readonly monthlyCapUsd: number
  }
  /**
   * The Channels roma answers on, each bound to its Transport by `bind`.
   *
   * One Core per Channel, over one of everything else here: the queue, the
   * pool, the Work Root, the Audit Log and the three Chosen Records are built
   * once and handed to every Core, so every cap is the process's.
   */
  readonly channels: readonly ChannelBinding[]
  /** Where Sessions get their working directories, one each. */
  readonly workRoot: string
  /**
   * Where the Audit Records go, one file per calendar month.
   *
   * Required, never defaulted. Enforced by `fence:startup-durable-paths-are-required`.
   */
  readonly auditRoot: string
  /**
   * CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR, both pointed here.
   *
   * Required, never defaulted. Enforced by `fence:startup-durable-paths-are-required`.
   */
  readonly configDir: string
  /**
   * One Reach per credential a Session's tools can ask for, each proved live
   * before anything that could accept an Ingress Message exists. None can be
   * left out. Enforced by `fence:startup-every-reach-is-named`.
   *
   * A deployment with no key for one passes its unavailable arm.
   */
  readonly reaches: Reaches
  /** roma's own directory, and the gitconfig every Session runs under. */
  readonly shims: ShimsOptions
  /** The Pinned Model. Defaults to `PINNED_MODEL`. */
  readonly model?: string
  /**
   * The Pinned Effort. Defaults to `PINNED_EFFORT`. May name `ultracode`, which
   * is off the Effort Menu, as `model` may name a model off the Model Menu.
   */
  readonly effort?: string
  /**
   * The Pinned Caveman. Defaults to `off`, which appends no text at all, so
   * omitting it leaves the spawn arguments byte for byte unchanged. May name
   * `wenyan-lite` or `wenyan-ultra`, which are off the Caveman Menu.
   */
  readonly caveman?: string
  readonly maxConcurrentTasks?: number
  readonly retryBudget?: RetryBudget
  readonly spawn?: SpawnClaudeProcess
  /**
   * The Operator Log, one for every component: an operator reading a credential
   * swap wants the refusal that prompted it on the same lines.
   */
  readonly log?: OperatorLog<
    PoolLogRecord | CoreLogRecord | ShimLogRecord | ReachLogRecord | SelfCheckLogRecord
  >
  /**
   * Where the self-check's probe runs: a throwaway directory by default,
   * removed once the check is done. Not under `workRoot`, which holds only
   * Sessions roma serves.
   */
  readonly selfCheckCwd?: string
  readonly selfCheckTimeoutMs?: number
}

/** roma, running. */
export interface Roma {
  /** One Core per binding, in the order the bindings were given. */
  readonly channels: readonly BoundChannel[]
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
 * Nothing that can accept an ingress message exists until the self-check has
 * passed. Enforced by `fence:startup-nothing-before-the-self-check`.
 *
 * The pool, the queue and the generation record are built once, for every
 * Core. Enforced by
 * `fence:startup-one-queue-for-every-channel` and
 * `fence:startup-one-session-record-for-every-channel`.
 */
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
  // Enforced by `fence:startup-reaches-proved-one-at-a-time`.
  const proved = new Map<CredentialWanted, string | null>()
  for (const reach of eachReach(reaches)) {
    const { account } = await reach.prove()
    proved.set(reach.credential, account)
    // Enforced by `fence:startup-reach-line-every-boot`.
    log?.({ event: 'reach', credential: reach.credential, account })
  }

  // What the deployment pinned, named once rather than defaulted in each of the
  // three places that need it. `/model default` returns a Session to *this*
  // rather than to a literal, which is the whole of why `ROMA_MODEL` and a Chosen
  // Model cannot come to disagree.
  const pinnedModel = model ?? PINNED_MODEL
  // The same, for the effort. `/effort default` returns a Session to *this*
  // rather than to a literal, which is why `ROMA_EFFORT` and a Chosen Effort
  // cannot come to disagree. Validated in `readRomaEnv` before it reaches here —
  // Claude Code would not refuse a wrong one.
  const pinnedEffort = effort ?? PINNED_EFFORT
  // The same again, and the default is the one that means "say nothing" — which
  // is what makes a deployment that named none unchanged by ADR-0030.
  // `/caveman default` returns a Session to *this* rather than to a literal, for
  // the reason the two above do. Validated in `readRomaEnv` before it reaches
  // here, where unlike the effort there is no Runtime that could have refused it
  // either.
  const pinnedCaveman = caveman ?? CAVEMAN_OFF

  // Built once and handed to both the check and the pool, so that what was
  // verified is the environment roma actually runs on rather than one built the
  // same way and hoped to be identical. The probe's own environment carries no
  // Shim variables: it is not a Session roma serves, it has no Session id, and
  // it is not there to clone anything.
  const env = buildEnv({ credential, configDir })

  const probeCwd = selfCheckCwd ?? mkdtempSync(join(tmpdir(), 'roma-self-check-'))
  let selfCheck: StartupSelfCheckReport
  try {
    selfCheck = await startupSelfCheck({
      credential,
      env,
      cwd: probeCwd,
      ...(model === undefined ? {} : { model }),
      // The Pinned Effort rather than the option, because unlike the model this
      // one is *asked about* — the probe is spawned with it and then relayed
      // `/effort current`, so what is compared has to be the resolved value
      // rather than "whatever the default is on both sides".
      effort: pinnedEffort,
      ...(spawn === undefined ? {} : { spawn }),
      ...(selfCheckTimeoutMs === undefined ? {} : { timeoutMs: selfCheckTimeoutMs }),
      ...(log === undefined ? {} : { log }),
    })
  } finally {
    // Ours to clean up only if it was ours to create.
    if (selfCheckCwd === undefined) rmSync(probeCwd, { recursive: true, force: true })
  }

  // roma's own directory, made before anything points at it. The gitconfig goes
  // in beside the socket rather than in a Working Directory, for the reason
  // `ShimsOptions` gives: the agent runs `git add -A` in one of those.
  mkdirSync(shims.dir, { recursive: true, mode: 0o700 })
  const gitConfigPath = join(shims.dir, 'gitconfig')
  writeFileSync(gitConfigPath, shims.gitConfig, { mode: 0o600 })
  const socketPath = socketPathIn(shims.dir)

  const queue = new TaskQueue(
    maxConcurrentTasks === undefined ? {} : { maxConcurrent: maxConcurrentTasks },
  )
  // Between the socket and the Audit Record, and built here because this is the
  // only place that can see both ends. One per Reach whose Audit Record field is
  // a yes or a no, which is two of the three — the forge's answer is a list of
  // repositories and is a separate ticket.
  //
  // Made whether or not the deployment has either Reach: without one nothing ever
  // puts a Task in it, so every record says no, which is true.
  const cloudUse = new ReachUse()
  const documentUse = new ReachUse()
  const shimServer = await ShimServer.listen({
    socketPath,
    // Enforced by `fence:startup-one-fresh-tokens-per-reach`.
    reaches: servedReaches(reaches, proved, log),
    // Every request over the socket, whichever credential it was for. What is kept
    // of it is decided one layer up — the socket knows a request happened and
    // which Task the queue says its Session was running, and nothing else should
    // be asked of it (ADR-0020 §6).
    onCredential: (taskId, credential) => {
      if (credential === 'cloud') cloudUse.minted(taskId)
      if (credential === 'documents') documentUse.minted(taskId)
    },
    // Attribution is by Session, resolved to a Task through the queue — which
    // serialises the Tasks of a Session already, so the answer is unambiguous.
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

  // Enforced by `fence:startup-core-and-pool-share-the-work-root`.
  const work = new WorkRoot(workRoot)

  // Enforced by `fence:startup-pool-reads-the-chosen-records`.
  const models = chosenModels({ workRoot: work, pinnedModel })
  const efforts = chosenEfforts({ workRoot: work, pinnedEffort })
  const cavemen = chosenCavemen({ workRoot: work, pinnedCaveman })

  const pool = new SessionPool({
    workRoot: work,
    envs,
    // No `model`, `effort` or `caveman` beside them: the three records are what
    // answer, and a second copy of any pinned value here would be a second thing
    // to keep in step.
    models,
    efforts,
    cavemen,
    // What every Reach has to say, in the order they were proved, and no more
    // than that. What a Session is *told* is this plus its own Caveman, joined in
    // the pool — because half of it is the deployment's and half is the Session's,
    // and the pool is the only thing that knows which Session it is about to
    // start (ADR-0030's first Consequence).
    //
    // Handed over unfiltered: an unavailable Reach announces nothing, and
    // dropping the empty parts is one rule applied at the join rather than at
    // both ends of this seam.
    announcements: eachReach(reaches).map((reach) => reach.announce()),
    ...(retryBudget === undefined ? {} : { retryBudget }),
    ...(spawn === undefined ? {} : { spawn }),
    ...(log === undefined ? {} : { log }),
  })
  const sessions = new SessionGenerations({ workRoot: work })
  const audit = new AuditLog({ auditRoot })

  // Everything a Core is made of except the Channel it answers on, built once
  // and given to each of them — `StartRomaOptions.channels` is why every one of
  // these is roma's rather than any Channel's.
  //
  // The credential is handed over as well as the environment built from it,
  // because the record has to say which of the two bills a Task landed on and
  // the environment is a map of secrets rather than an answer to that.
  const shared: Omit<CoreOptions, 'channel'> = {
    pool,
    // Enforced by `fence:startup-core-and-pool-share-the-work-root`.
    workRoot: work,
    queue,
    sessions,
    models,
    efforts,
    cavemen,
    // Told separately from the record beside it, because this is the last line
    // that can still see the difference: `pinnedCaveman` above folded a
    // deployment that named nothing into the same `off` a deployment that
    // pinned one has, and the Audit Record is the one place they may not be one
    // string (ADR-0030).
    cavemanPinned: caveman !== undefined,
    audit,
    credential: credential.kind,
    usedCloudReach: (taskId) => cloudUse.takeUsedBy(taskId),
    usedDocumentReach: (taskId) => documentUse.takeUsedBy(taskId),
    ...(overflow === undefined ? {} : { overflow: { monthlyCapUsd: overflow.monthlyCapUsd } }),
    ...(log === undefined ? {} : { log }),
  }

  return {
    // Enforced by `fence:startup-each-core-on-its-own-channel`.
    channels: channels.map((binding) =>
      binding.coreOver((channel) => new Core({ channel, ...shared })),
    ),
    pool,
    queue,
    sessions,
    audit,
    selfCheck,
    // Enforced by `fence:startup-socket-closed-after-the-processes`.
    shutdown: async () => {
      try {
        await pool.shutdown()
      } finally {
        // Enforced by `fence:startup-socket-closed-whatever-the-pool-did`.
        await shimServer.close()
      }
    },
  }
}

/**
 * One `FreshTokens` per Reach that has a key, and the sentence for the one that
 * does not.
 *
 * Built here rather than inside a Reach so that the mint record stays in the Core
 * beside every other Operator Log record: a Reach hands over a `MintsTokens` and
 * roma does the arithmetic — see ADR-0020's Consequences. The account comes
 * from what the Reach proved rather than from the Reach, because proving is the
 * only thing that learns it.
 */
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
