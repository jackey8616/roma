import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog } from './audit-log.js'
import { buildEnv, type Credential } from './build-env.js'
import { PINNED_EFFORT, PINNED_MODEL } from './claude-session.js'
import type { CredentialEnvs } from './session-pool.js'
import type { ChannelAdapter } from './channel-adapter.js'
import type { SpawnClaudeProcess } from './claude-process.js'
import type { RetryBudget } from './config.js'
import { CloudReachUse } from './cloud-reach-use.js'
import { Core, type CoreLogRecord } from './core.js'
import { ConfigurationMissing } from './env-config.js'
import { FreshTokens } from './fresh-tokens.js'
import type { CloudMinter, CloudReach, Installation, Minter } from './minter.js'
import { ChosenEfforts, ChosenModels, SessionGenerations } from './session-generation.js'
import { reasonOf, type OperatorLog } from './operator-log.js'
import { SessionPool, type PoolLogRecord } from './session-pool.js'
import { socketPathIn } from './shim-protocol.js'
import { ShimServer, type ShimLogRecord } from './shim-server.js'
import {
  startupSelfCheck,
  type SelfCheckLogRecord,
  type StartupSelfCheckReport,
} from './startup-self-check.js'
import { TaskQueue } from './task-queue.js'

/**
 * Everything roma needs to put a credential in front of a Session's tools.
 *
 * One option rather than four loose ones, because they are one decision: a roma
 * with a Minter and no socket to answer on, or a socket and no gitconfig
 * pointing at it, is a roma whose agent cannot reach a line of anybody's code —
 * and required means required (ADR-0008). Nothing in here names a forge; what
 * does lives under `src/github/` and reaches this as values.
 */
export interface MintingOptions {
  /** The only thing that holds the App's private key. */
  readonly minter: Minter
  /**
   * roma's own directory: the Credential Shim socket, and the gitconfig every
   * Session runs under.
   *
   * Deliberately not under `workRoot`. That tree is reclaimed after seven idle
   * days, and a reclaimed socket would present as every credential request in
   * roma failing at once with no explanation. Not inside a Working Directory
   * either — the agent runs `git add -A` in there.
   */
  readonly shimDir: string
  /**
   * The gitconfig `GIT_CONFIG_GLOBAL` points every Session at, as text.
   *
   * Written here rather than composed here: what it has to say — which helper,
   * and that the helper is told the repository path — is knowledge about `git`
   * and about a forge, and roma's job is to put the file somewhere that is not
   * a Working Directory and to name it in the environment.
   */
  readonly gitConfig: string
  /**
   * What every Session is told it can reach, given what roma found at boot.
   *
   * A function rather than a string, because the answer is not known until the
   * Installation has been fetched — and fetching it is the boot check, which has
   * to happen inside this function for the same reason the self-check does.
   */
  readonly announce: (installation: Installation) => string
}

/**
 * What roma needs to give a Session's work a Cloud Token, where a deployment has
 * a Cloud Reach.
 *
 * Optional in `StartRomaOptions` and complete when it is there, which is the
 * `MintingOptions` shape rather than the Overflow shape — but for the opposite
 * reason. Overflow is refused half-configured because a cap with no key caps
 * nothing; there is no half of this to configure, because both halves come out
 * of one key file. What makes it one object is the same rule: a Minter with
 * nothing announcing it is a capability the agent will never try.
 */
export interface CloudOptions {
  /** The only thing that holds the Cloud Reach's key. */
  readonly minter: CloudMinter
  /**
   * What every Session is told it can reach in the cloud.
   *
   * A function for the reason the Installation's is, minus the fetching: the
   * text names the identity, and naming a provider's identity is not something
   * the Core may do. It reaches here as a value.
   */
  readonly announce: (reach: CloudReach) => string
}

/** What an operator is told about the Cloud Reach: once at boot, and per mint. */
export type CloudLogRecord =
  | {
      /**
       * Whether this deployment has a Cloud Reach, and which identity it is.
       *
       * Written on every boot, including the boots where the answer is "none".
       * Which deployment an operator is looking at is exactly the question, and
       * a line that appeared only sometimes would make its absence mean two
       * things — no Cloud Reach, or an older roma.
       *
       * It is also the record of the boot proof: the line is written after the
       * mint that proved the key, so a boot that reaches it is a boot where the
       * Cloud Reach worked. That mint gets no `cloud-token-minted` of its own,
       * because it was never served to anybody and counting it would put a
       * standing +1 on every deployment's mint rate.
       */
      readonly event: 'cloud-reach'
      readonly account: string | null
    }
  | {
      /**
       * A Cloud Token was minted — not merely asked for.
       *
       * The distinction is the whole reason this is a record rather than a
       * field on the credential line beside it. Something in the agent's
       * userland asks on every invocation by design, and almost every ask is
       * served from the token roma already holds; a mint is a signed assertion
       * and a round trip to the provider. An operator watching for a mint storm
       * needs the count that can actually storm.
       */
      readonly event: 'cloud-token-minted'
      readonly account: string
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
  /** How a Session's tools get a credential, and what it reaches. */
  readonly minting: MintingOptions
  /**
   * The Cloud Reach, where this deployment has one.
   *
   * Absent is the ordinary case and costs nothing: roma starts, announces
   * nothing about the cloud, and the Cloud Shortcut answers that there is none
   * (ADR-0015 §9). Present, it is proved live before anything can accept an
   * Ingress Message — see the boot proof in `startRoma`.
   */
  readonly cloud?: CloudOptions
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
    PoolLogRecord | CoreLogRecord | ShimLogRecord | CloudLogRecord | SelfCheckLogRecord
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
  readonly core: Core
  readonly pool: SessionPool
  readonly queue: TaskQueue
  readonly sessions: SessionGenerations
  /** Every Task roma has run, and what each one cost. */
  readonly audit: AuditLog
  /** What the self-check found, for the boot log. */
  readonly selfCheck: StartupSelfCheckReport
  /** What roma proved at boot that it can reach, and told every Session about. */
  readonly installation: Installation
  /** The identity the agent acts as in the cloud, or null where there is none. */
  readonly cloudReach: CloudReach | null
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
  minting,
  cloud,
  model,
  effort,
  maxConcurrentTasks,
  retryBudget,
  spawn,
  log,
  selfCheckCwd,
  selfCheckTimeoutMs,
}: StartRomaOptions): Promise<Roma> {
  // First, because it is free and the other check is not. A bad private key or
  // an App installed twice is found before a single paid Turn has been driven,
  // and a deployment that is wrong in both ways is told about the cheap one
  // first. It blocks the boot for the reason the self-check does: a failure that
  // surfaced instead as an inexplicable `git clone` inside somebody's Turn would
  // read as "roma is broken" with no diagnosis attached.
  const installation = await minting.minter.installation()

  // The other free check, and the same argument: a key that is syntactically
  // perfect and revoked is a blind spot no amount of parsing closes, so roma
  // uses the key rather than reading it. The token is thrown away — what is
  // being proved is that one can be had at all.
  //
  // It lives here rather than in `startup-self-check.ts` deliberately. That term
  // is defined as the live *Turn* roma drives at boot, and a check driving no
  // Turn would make the definition false (ADR-0015 §8). It never falls back to
  // another identity, which is the whole reason the key is loaded by an exact
  // path in the first place.
  //
  // **It refuses in `readConfiguration`'s shape rather than inside it, and that
  // is a gap rather than a choice.** ADR-0015 §8 asks for "one of the problems
  // the single `readConfiguration` refusal reports"; that reader is synchronous
  // and this is a network round trip, so a deployment with both a missing audit
  // root and a revoked key still boots twice. Everything a *file* can be wrong
  // about — unreadable, empty, not a key — is caught by `readCloudEnv` and does
  // join the single refusal; only a key that parses and does not work lands
  // here. The line above has the same property for a bad App key and has since
  // ADR-0008, so this is the existing shape rather than a new one. Closing it
  // means `readConfiguration` collecting problems instead of throwing them,
  // which is a change to how every reader reports and is not this ticket's.
  if (cloud !== undefined) {
    try {
      await cloud.minter.mint()
    } catch (error) {
      throw new ConfigurationMissing([
        `roma could not mint a Cloud Token with the key it was given, so its Cloud Reach ` +
          `(${cloud.minter.account}) does not work: ${reasonOf(error)}`,
      ])
    }
  }
  const cloudReach: CloudReach | null = cloud === undefined ? null : { account: cloud.minter.account }
  // Said on every boot, including the boots with nothing to say, so that which
  // deployment this is can be read off the log rather than inferred from a line
  // that is not there.
  log?.({ event: 'cloud-reach', account: cloudReach?.account ?? null })

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
  // `MintingOptions` gives: the agent runs `git add -A` in one of those.
  mkdirSync(minting.shimDir, { recursive: true, mode: 0o700 })
  const gitConfigPath = join(minting.shimDir, 'gitconfig')
  writeFileSync(gitConfigPath, minting.gitConfig, { mode: 0o600 })
  const socketPath = socketPathIn(minting.shimDir)

  const queue = new TaskQueue(
    maxConcurrentTasks === undefined ? {} : { maxConcurrent: maxConcurrentTasks },
  )
  // Between the socket and the Audit Record, and built here because this is the
  // only place that can see both ends. Made whether or not there is a Cloud
  // Reach: without one nothing ever puts a Task in it, so every record says no,
  // which is true.
  const cloudUse = new CloudReachUse()
  const shims = await ShimServer.listen({
    socketPath,
    tokens: new FreshTokens({ minter: minting.minter }),
    // Two `FreshTokens` rather than one, because they hold two credentials with
    // two expiries. The arithmetic is one class; the state is not shared.
    cloud:
      cloud === undefined
        ? null
        : {
            tokens: new FreshTokens({
              minter: cloud.minter,
              // What makes a mint storm visible. The credential line beside this
              // one is written per *request*, and a Cloud Shortcut asks on every
              // invocation by design — so without this an operator counting the
              // log cannot tell a loop that is minting from a loop that is being
              // served the token roma already holds.
              onMint: () => log?.({ event: 'cloud-token-minted', account: cloud.minter.account }),
            }),
            account: cloud.minter.account,
          },
    onCloudToken: (taskId) => {
      cloudUse.minted(taskId)
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

  // Beside the generations, and handed to both the pool and the Core. What has
  // to be one thing is the *work root* rather than the object — `ChosenModels`
  // keeps nothing between calls, it reads and writes files — and passing one
  // instance to both is how that is made true rather than hoped for. What must
  // not happen is the pool being built without it: roma would answer `/model`
  // perfectly, write a perfect record, and run every Turn on the Pinned Model.
  const models = new ChosenModels({ workRoot, pinnedModel })
  // Beside them, and handed to both for the same reason and at higher stakes: a
  // pool built without this answers `/effort` perfectly, writes a perfect record,
  // and runs every Turn at the Pinned Effort — with nothing anywhere in the
  // stream to contradict it, because `system/init` carries no effort field.
  const efforts = new ChosenEfforts({ workRoot, pinnedEffort })

  const pool = new SessionPool({
    workRoot,
    envs,
    // No `model` or `effort` beside them: `models` and `efforts` are what
    // answer, and a second copy of either pinned value here would be a second
    // thing to keep in step.
    models,
    efforts,
    // Both announcements, or only the one there is. A blank line between them
    // rather than a joined paragraph, because they are two capabilities and an
    // agent skimming a system prompt reads a break as a change of subject —
    // which it is.
    appendSystemPrompt: [
      minting.announce(installation),
      ...(cloud === undefined || cloudReach === null ? [] : [cloud.announce(cloudReach)]),
    ].join('\n\n'),
    ...(retryBudget === undefined ? {} : { retryBudget }),
    ...(spawn === undefined ? {} : { spawn }),
    ...(log === undefined ? {} : { log }),
  })
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
      models,
      efforts,
      audit,
      credential: credential.kind,
      usedCloudReach: (taskId) => cloudUse.takeUsedBy(taskId),
      ...(overflow === undefined ? {} : { overflow: { monthlyCapUsd: overflow.monthlyCapUsd } }),
      ...(log === undefined ? {} : { log }),
    }),
    pool,
    queue,
    sessions,
    audit,
    selfCheck,
    installation,
    cloudReach,
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
        await shims.close()
      }
    },
  }
}
