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

/**
 * roma's own directory, and what roma writes into it.
 *
 * One option rather than two loose ones, because they are one decision: a roma
 * with a socket to answer on and no gitconfig pointing at it is a roma whose
 * agent cannot reach a line of anybody's code. Not a Reach's — the socket serves
 * every credential there is, and the gitconfig is how `git`'s Credential Shim is
 * installed rather than anything about minting (ADR-0020 §3).
 */
export interface ShimsOptions {
  /**
   * roma's own directory: the Credential Shim socket, and the gitconfig every
   * Session runs under.
   *
   * Deliberately not under `workRoot`. That tree is reclaimed after seven idle
   * days, and a reclaimed socket would present as every credential request in
   * roma failing at once with no explanation. Not inside a Working Directory
   * either — the agent runs `git add -A` in there.
   */
  readonly dir: string
  /**
   * The gitconfig `GIT_CONFIG_GLOBAL` points every Session at, as text.
   *
   * Written here rather than composed here: what it has to say — which helper,
   * and that the helper is told the repository path — is knowledge about `git`
   * and about a forge, and roma's job is to put the file somewhere that is not
   * a Working Directory and to name it in the environment.
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
       * "none". Which deployment an operator is looking at is exactly the
       * question, and a line that appeared only sometimes would make its absence
       * mean two things — no Reach, or an older roma.
       *
       * It is also the record of the boot proof: the line is written after the
       * proof, so a boot that reaches it is a boot where that Reach worked. A
       * proof that minted gets no `reach-token-minted` of its own, because that
       * token was never served to anybody and counting it would put a standing +1
       * on every deployment's mint rate.
       */
      readonly event: 'reach'
      readonly credential: CredentialWanted
      readonly account: string | null
    }
  | {
      /**
       * A credential was minted — not merely asked for.
       *
       * The distinction is the whole reason this is a record rather than a field
       * on the credential line beside it. Something in the agent's userland asks
       * on every invocation by design, and almost every ask is served from the
       * token roma already holds; a mint is a signed assertion and a round trip to
       * the provider. An operator watching for a mint storm needs the count that
       * can actually storm.
       *
       * Written for every Reach, which for the forge is new: `git` asks far more
       * often than a Cloud Shortcut does, so the argument that produced this
       * record applies there harder than where it was written (ADR-0020 §5).
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
   * The Channels roma answers on, each bound to the Transport its events arrive
   * over.
   *
   * **One Core per Channel, over one of everything else here.** The queue, the
   * pool, the Work Root, the Audit Log and the three Chosen Records are built
   * once below and handed to every Core; what that buys the Core is
   * `CoreOptions.channel`, which has said it since there was one Channel.
   *
   * **One process, and that is the half this adds.** Every cap roma has is a
   * process's: the concurrency cap is three against one Shared Window rather
   * than three per Channel, and the Overflow monthly cap is enforced against the
   * sum of one month's Audit Records under one root. A process per Channel would
   * double both with no configuration looking wrong, which is the alternative
   * ADR-0028 rejected.
   *
   * Passed in rather than built here: constructing a Channel Adapter needs that
   * Channel's own API client and its own credentials, which is the deployment's
   * business and not roma's. `bind` is the only way to make one of these, and
   * why is written there.
   */
  readonly channels: readonly ChannelBinding[]
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
  /**
   * One Reach per credential a Session's tools can ask for.
   *
   * Every one of them is proved live before anything that could accept an Ingress
   * Message exists. A record rather than a list so that none can be left out: a
   * roma with no `code` Reach would prove no key, announce nothing, and fail every
   * `git` request inside somebody's Turn, which is the failure blocking the boot
   * exists to prevent (ADR-0008, ADR-0020 §3).
   *
   * A deployment with no cloud key has a Cloud Reach all the same — the
   * unavailable one, which announces nothing and answers the Cloud Shortcut that
   * there is none (ADR-0015 §9). The same is true of the Document Reach, and for
   * most deployments both of them are that arm (ADR-0022 §8).
   */
  readonly reaches: Reaches
  /** roma's own directory, and the gitconfig every Session runs under. */
  readonly shims: ShimsOptions
  /** The pinned model. Defaults to the one every Session runs on. */
  readonly model?: string
  /**
   * The Pinned Effort. Defaults to the one every Session runs at.
   *
   * Optional where the Overflow cap is required, and the difference is what each
   * authorises: the cap opens a new way to spend money, and effort is money
   * already being spent under another name (ADR-0016). It may name `ultracode`,
   * which is off the Effort Menu — the Menu bounds Callers and never the
   * operator, exactly as `model` may already name a model off the Model Menu.
   */
  readonly effort?: string
  /**
   * The Pinned Caveman. Defaults to `off`, which appends no text at all.
   *
   * Optional in a stronger sense than the two above, and this is the half of that
   * a caller has to know: they default to what a Session would have run on
   * anyway, where omitting this leaves the spawn arguments byte for byte what
   * they were before ADR-0030 — so a deployment that names nothing is not
   * changed, rather than changed to a default.
   *
   * It may name `wenyan-lite` or `wenyan-ultra`, which are off the Caveman Menu,
   * on the rule `effort` above already carries.
   */
  readonly caveman?: string
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
  readonly log?: OperatorLog<
    PoolLogRecord | CoreLogRecord | ShimLogRecord | ReachLogRecord | SelfCheckLogRecord
  >
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
  /** One Core per binding, in the order the bindings were given. */
  readonly channels: readonly BoundChannel[]
  readonly pool: SessionPool
  readonly queue: TaskQueue
  readonly sessions: SessionGenerations
  /** Every Task roma has run, and what each one cost. */
  readonly audit: AuditLog
  /** What the self-check found, for the boot log. */
  readonly selfCheck: StartupSelfCheckReport
  /**
   * End every resident process. Sessions keep their context on disk.
   *
   * What roma proved about each Reach is deliberately not here. It was reported
   * to nobody — no production caller read either field — and what an operator
   * wants is on the boot log, which now carries a line per Reach (ADR-0020 §4).
   */
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
 * and a Core that made its own would turn each of them into one per Channel,
 * which is now a live mistake rather than an anticipated one.
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
  // **One at a time, in this order, and `code` first.** The order used to be
  // enforced by data flow — two statements, one after the other — and a loop is
  // where that is lost. `await Promise.all(…)` compiles, reads as the natural
  // generic form, and takes two properties with it: a deployment broken in both
  // ways is told about the free check first, and a boot with a bad App key makes
  // no network call to the *other* provider at all (ADR-0020 §4).
  //
  // Each proof blocks the boot for the reason the self-check does: a failure that
  // surfaced instead as an inexplicable `git clone` inside somebody's Turn would
  // read as "roma is broken" with no diagnosis attached. How a Reach refuses is
  // the Reach's own — the forge names what it found, and the cloud wraps itself in
  // `readConfiguration`'s shape (ADR-0015 §8).
  const proved = new Map<CredentialWanted, string | null>()
  for (const reach of eachReach(reaches)) {
    const { account } = await reach.prove()
    proved.set(reach.credential, account)
    // Said on every boot for every Reach, including the ones with nothing to say,
    // so that which deployment this is can be read off the log rather than
    // inferred from a line that is not there.
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
      // Unchanged by ADR-0014, and deliberately: no Chosen Model can reach the
      // probe, which is not a Session roma serves. What this proves is that the
      // deployment boots on what it pinned.
      ...(model === undefined ? {} : { model }),
      // The Pinned Effort rather than the option, because unlike the model this
      // one is *asked about* — the probe is spawned with it and then relayed
      // `/effort current`, so what is compared has to be the resolved value
      // rather than "whatever the default is on both sides".
      effort: pinnedEffort,
      ...(spawn === undefined ? {} : { spawn }),
      ...(selfCheckTimeoutMs === undefined ? {} : { timeoutMs: selfCheckTimeoutMs }),
      // A disagreement about the effort is an anomaly rather than a refusal, so
      // it lands in the same log as everything else an operator reads. Boot
      // continues.
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
    // One `FreshTokens` per Reach, never one shared: they hold different
    // credentials with different expiries. The arithmetic is one class; the state
    // is not.
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

  // One environment per credential a Turn can be paid for by. Overflow is not a
  // mode roma is put into — ADR-0002 makes it exactly this, a different map —
  // and the pool picks between them per Turn. Both reach the same socket: a
  // credential for reaching the code has nothing to do with which bill a Turn
  // lands on.
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

  // The tree every Session's Working Directory sits in, and every record roma
  // keeps about a Conversation beside them. Built once and handed to all five
  // things under it — the pool, the three record classes and the Core — so none
  // of them is told a path to join for itself.
  //
  // What they have to agree on is the *path*, not this object: nothing here is
  // held between calls, so two of these over one root behave identically. One
  // instance is how that agreement is made rather than hoped for, which is the
  // argument `ChosenRecord` makes for itself below. Two over *different* roots
  // is the failure, and `CoreOptions.workRoot` is where what it costs is
  // written down.
  const work = new WorkRoot(workRoot)

  // Beside the generations, and handed to both the pool and the Core. What has
  // to be one thing is the *work root* rather than the object — `ChosenRecord`
  // keeps nothing between calls, it reads and writes files — and passing one
  // instance to both is how that is made true rather than hoped for. What must
  // not happen is the pool being built without it: roma would answer `/model`
  // perfectly, write a perfect record, and run every Turn on the Pinned Model.
  const models = chosenModels({ workRoot: work, pinnedModel })
  // Beside them, and handed to both for the same reason and at higher stakes: a
  // pool built without this answers `/effort` perfectly, writes a perfect record,
  // and runs every Turn at the Pinned Effort — with nothing anywhere in the
  // stream to contradict it, because `system/init` carries no effort field.
  const efforts = chosenEfforts({ workRoot: work, pinnedEffort })
  // And the third, handed to both for the reason the first two are, at stakes of
  // a third kind: a pool built without this answers `/caveman` perfectly, writes
  // a perfect record, and appends the Pinned Caveman's ruleset to every Session —
  // and what contradicts it is nothing anybody can point at, only roma answering
  // at the wrong length.
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
    // The same Work Root the pool was given, which is what makes an Enclosure
    // land where the Session that was told about it will look.
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
    // Not built here and handed to a binding: a Core paired with the wrong
    // Channel would answer every message into somebody else's product, and
    // nothing downstream of here could tell. Each binding builds its own, over
    // its own Adapter.
    channels: channels.map((binding) =>
      binding.coreOver((channel) => new Core({ channel, ...shared })),
    ),
    pool,
    queue,
    sessions,
    audit,
    selfCheck,
    // The socket goes after the processes, not before: a Session being killed can
    // still have a `git` mid-operation, and taking the credential away first
    // turns a clean shutdown into a handful of authentication failures in
    // somebody's Transcript.
    shutdown: async () => {
      try {
        await pool.shutdown()
      } finally {
        // Whatever the pool did. A socket left listening on a roma that is
        // otherwise gone is a credential still being served to nothing.
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
        // What makes a mint storm visible. The credential line beside this one is
        // written per *request*, and things in the agent's userland ask on every
        // invocation by design — so without this an operator counting the log
        // cannot tell a loop that is minting from a loop that is being served the
        // token roma already holds.
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
