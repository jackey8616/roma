import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog } from './audit-log.js'
import { buildEnv, type Credential } from './build-env.js'
import { PINNED_MODEL } from './claude-session.js'
import type { CredentialEnvs } from './session-pool.js'
import type { ChannelAdapter } from './channel-adapter.js'
import type { SpawnClaudeProcess } from './claude-process.js'
import type { RetryBudget } from './config.js'
import { Core, type CoreLogRecord } from './core.js'
import { InstallationTokens } from './installation-tokens.js'
import type { Installation, Minter } from './minter.js'
import { ChosenModels, SessionGenerations } from './session-generation.js'
import type { OperatorLog } from './operator-log.js'
import { SessionPool, type PoolLogRecord } from './session-pool.js'
import { socketPathIn } from './shim-protocol.js'
import { ShimServer, type ShimLogRecord } from './shim-server.js'
import { startupSelfCheck, type StartupSelfCheckReport } from './startup-self-check.js'
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
  readonly log?: OperatorLog<PoolLogRecord | CoreLogRecord | ShimLogRecord>
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
  model,
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

  // What the deployment pinned, named once rather than defaulted in each of the
  // three places that need it. `/model default` returns a Session to *this*
  // rather than to a literal, which is the whole of why `ROMA_MODEL` and a Chosen
  // Model cannot come to disagree.
  const pinnedModel = model ?? PINNED_MODEL

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
      ...(spawn === undefined ? {} : { spawn }),
      ...(selfCheckTimeoutMs === undefined ? {} : { timeoutMs: selfCheckTimeoutMs }),
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
  const shims = await ShimServer.listen({
    socketPath,
    tokens: new InstallationTokens({ minter: minting.minter }),
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

  const pool = new SessionPool({
    workRoot,
    envs,
    // No `model` beside it: `models` is what answers, and a second copy of the
    // Pinned Model here would be a second thing to keep in step with the one
    // `ChosenModels` holds.
    models,
    appendSystemPrompt: minting.announce(installation),
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
    installation,
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
