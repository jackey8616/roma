import { fileURLToPath } from 'node:url'
import { readCloudEnv } from '../cloud/env-config.js'
import { cloudReachFrom } from '../cloud/reach.js'
import type { CoreLogRecord } from '../core.js'
import { readDocumentEnv } from '../documents/env-config.js'
import { documentReachFrom } from '../documents/reach.js'
import { readConfiguration, type Environment } from '../env-config.js'
import { readMinterEnv } from '../github/env-config.js'
import { githubReachFrom } from '../github/reach.js'
import { gitConfig } from '../github/shims.js'
import { writeToStderr, type OperatorLog } from '../operator-log.js'
import { serve, type ChannelBinding, type IngressLogRecord, type Serving } from '../serve.js'
import type { PoolLogRecord } from '../session-pool.js'
import type { ShimLogRecord } from '../shim-server.js'
import type { ReachLogRecord } from '../startup.js'
import type { SelfCheckLogRecord, StartupSelfCheckReport } from '../startup-self-check.js'
import { discordBinding, type DiscordLogRecord } from './discord/binding.js'
import { readDiscordEnv } from './discord/env-config.js'
import { googleChatBinding, type ChatLogRecord } from './google-chat/binding.js'
import { readChatEnv } from './google-chat/env-config.js'

/**
 * roma as a program: every Channel this deployment configured, over one pool.
 *
 * The composition root. It lives under `src/channels/` and inside no Channel's
 * directory, and both halves of that are forced: assembling roma means naming
 * which Channels it is on and which queues they publish to, `src/` proper is not
 * allowed to know either — `src/core.test.ts` reads the sources and refuses —
 * and a root that names two Channels cannot live in one of their directories
 * (ADR-0028). Each Channel's own half is in its own directory, and this page
 * knows only that it has one.
 *
 * **Which Channels roma serves is the environment's answer, not this file's.**
 * Every Channel is optional and at least one is required, so a deployment that
 * names only Chat runs only Chat and pays nothing for the rest. Discord is the
 * second road (ADR-0029), and it cost this file exactly what the shape predicted
 * it would: one reader in the record handed to `readConfiguration`, and one
 * binding built where its configuration is there to build it from.
 *
 * Nothing is decided here. Every number is `env-config.ts`'s, every rule about
 * what happens to a message is `serve.ts`'s, and every Channel fact is that
 * Channel's. What is left is the wiring and the two things only the process
 * itself can do: exit, and answer a signal.
 */

/** What roma exits with when a signal, rather than a failure, ended it. */
const EXIT_SIGNALLED = 0
/** What roma exits with when it could not start, or could not stop cleanly. */
const EXIT_FAILED = 1

/** The two things only the whole program can say. */
type ProcessLogRecord =
  | { readonly event: 'serving'; readonly selfCheck: StartupSelfCheckReport }
  | { readonly event: 'stopping'; readonly signal: NodeJS.Signals }

/**
 * Everything roma writes to the operator log, from every part of it.
 *
 * Assembled here because this is the only place that knows what every part is:
 * the pool's and the Cores' records, the subscriber's, every Channel's own and
 * its Transport's, and the process's. One log rather than one per component —
 * they describe the same running system, and an operator reading a credential
 * swap wants the refusal that prompted it on the same lines.
 */
type RomaLog = OperatorLog<
  | PoolLogRecord
  | CoreLogRecord
  | IngressLogRecord
  | ShimLogRecord
  | ChatLogRecord
  | DiscordLogRecord
  | ReachLogRecord
  | SelfCheckLogRecord
  | ProcessLogRecord
>

/**
 * Build roma over the Channels this environment names, prove the credential, and
 * start receiving.
 *
 * Resolves once roma is receiving on all of them. Everything that can refuse to
 * start has refused by then: the configuration is read whole — one refusal
 * naming every Channel and every Reach that is wrong, rather than a boot per
 * problem — and the startup self-check has driven a real Turn and agreed that
 * auth resolves to the credential roma means to run on.
 */
export async function startConfiguredRoma(
  env: Environment = process.env,
  log: RomaLog = writeToStderr,
): Promise<Serving> {
  const { roma, channels, minterEnv, cloudEnv, documentEnv } = readConfiguration(
    env,
    { chat: readChatEnv, discord: readDiscordEnv },
    readMinterEnv,
    readCloudEnv,
    readDocumentEnv,
  )
  const { shimDir, ...core } = roma

  // One entry per Channel the deployment configured, built only for those: a
  // Channel roma was told nothing about has no client to construct and no
  // credential to resolve, so an unconfigured one costs a boot nothing at all.
  const bound: ChannelBinding[] = []
  if (channels.chat !== null) bound.push(await googleChatBinding(channels.chat, log))
  // Nothing is awaited here and nothing has connected yet: Discord's credential
  // is a token roma already holds, and the socket is opened when `serve`
  // subscribes rather than when the binding is built (ADR-0029).
  if (channels.discord !== null) bound.push(discordBinding(channels.discord, log))

  // The one place a forge is named, the one place the agent's cloud is, and the
  // one place the team's documents are, for the reason the Channels are named
  // here and nowhere else: assembling roma means saying what it is assembled out
  // of, and `src/` proper is not allowed to know any of the answers.
  // `src/github-containment.test.ts`, `src/cloud-containment.test.ts` and
  // `src/document-containment.test.ts` are what hold the rest of the tree to that.
  //
  // Note what this page does **not** do: construct either Google Minter.
  // `cloudReachFrom` and `documentReachFrom` each take the key their own reader
  // read from the path the deployment named and nothing else, and each lives
  // inside a directory bound against every way of asking a library to find a
  // credential — so the substitution ADR-0015 §4 forbids cannot be written here,
  // because neither constructor is named here (ADR-0020 §7).
  return await serve({
    ...core,
    reaches: {
      code: githubReachFrom(minterEnv),
      cloud: cloudReachFrom(cloudEnv),
      documents: documentReachFrom(documentEnv),
    },
    shims: { dir: shimDir, gitConfig: gitConfig() },
    channels: bound,
    log,
  })
}

/**
 * Run roma until something asks it to stop.
 *
 * The signal handling is here rather than inside `serve` because it is the
 * process's, not roma's: a roma embedded in something else would have its own
 * idea of when to shut down, and a library that installed handlers on
 * `process` would take that decision away from it.
 */
export async function main(): Promise<void> {
  const log = writeToStderr
  let serving: Serving
  try {
    serving = await startConfiguredRoma(process.env, log)
  } catch (error) {
    // The two refusals roma is designed to make — an incomplete configuration
    // and a failed self-check — both carry a message written for whoever is
    // standing roma up, and both are worth more on stderr than as a stack.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(EXIT_FAILED)
  }

  log({ event: 'serving', selfCheck: serving.selfCheck })
  stopOn(['SIGTERM', 'SIGINT'], serving, log)
}

/**
 * End roma when the host says so, and end it once.
 *
 * Shutting down takes as long as the running Turns take to be signalled and
 * exit, so a second signal is treated as somebody who is no longer prepared to
 * wait: roma leaves immediately, and the processes are the operating system's to
 * clean up. Better than the alternative, which is two shutdowns racing each
 * other over the same pool.
 */
function stopOn(signals: readonly NodeJS.Signals[], serving: Serving, log: RomaLog): void {
  let stopping = false
  for (const signal of signals) {
    process.on(signal, () => {
      if (stopping) {
        process.stderr.write(`${signal} again — leaving now.\n`)
        process.exit(EXIT_SIGNALLED)
      }
      stopping = true
      log({ event: 'stopping', signal })
      serving.shutdown().then(
        () => process.exit(EXIT_SIGNALLED),
        (error: unknown) => {
          // Said out loud rather than swallowed: what this failure means is
          // `claude` processes that may have outlived roma, and that is a thing
          // somebody has to know to go and look for.
          process.stderr.write(
            `roma did not shut down cleanly: ${error instanceof Error ? error.message : String(error)}\n`,
          )
          process.exit(EXIT_FAILED)
        },
      )
    })
  }
}

// Run only when this file is the program. Imported — by a test, or by something
// embedding roma — it defines the pieces and starts nothing.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main()
}
