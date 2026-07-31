import { fileURLToPath } from 'node:url'
import { Duration, PubSub } from '@google-cloud/pubsub'
import { GoogleAuth } from 'google-auth-library'
import { readConfiguration, type Environment } from '../../env-config.js'
import { writeToStderr, type OperatorLog } from '../../operator-log.js'
import { serve, type IngressLogRecord, type Serving } from '../../serve.js'
import type { CoreLogRecord } from '../../core.js'
import { readMinterEnv } from '../../github/env-config.js'
import { GitHubMinter } from '../../github/github-minter.js'
import { announce } from '../../github/announce.js'
import { gitConfig } from '../../github/shims.js'
import { announceCloud } from '../../cloud/announce.js'
import { readCloudEnv } from '../../cloud/env-config.js'
import { GoogleCloudMinter } from '../../cloud/google-cloud-minter.js'
import type { PoolLogRecord } from '../../session-pool.js'
import type { ShimLogRecord } from '../../shim-server.js'
import type { CloudLogRecord } from '../../startup.js'
import type { StartupSelfCheckReport } from '../../startup-self-check.js'
import { readChatEnv } from './env-config.js'
import type { ChatEventLogRecord } from './chat-events.js'
import { GoogleChatAdapter } from './google-chat-adapter.js'
import {
  CHAT_SCOPE,
  HttpChatApi,
  type DownloadChatMedia,
  type SendChatRequest,
} from './http-chat-api.js'
import { PubSubTransport, type PubSubLogRecord } from './pubsub-transport.js'

/**
 * roma as a program: Google Chat over Pub/Sub, assembled and running.
 *
 * The composition root, and it lives in the Channel's directory rather than at
 * the top of `src/` for the reason everything else here does — assembling roma
 * means naming which Channel it is on and which queue that Channel publishes to,
 * and `src/` proper is not allowed to know either. Today there is one deployment
 * and this is it. A second Channel gets a second one of these, over the same
 * Core.
 *
 * Nothing is decided here. Every number is `env-config.ts`'s, every rule about
 * what happens to a message is `serve.ts`'s, and every Chat fact is the
 * Adapter's. What is left is the wiring and the two things only the process
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
 * the pool's and the Core's records, the subscriber's, this Channel's Transport,
 * and the process's own. One log rather than one per component — they describe
 * the same running system, and an operator reading a credential swap wants the
 * refusal that prompted it on the same lines.
 */
type RomaLog = OperatorLog<
  | PoolLogRecord
  | CoreLogRecord
  | IngressLogRecord
  | ShimLogRecord
  | PubSubLogRecord
  | ChatEventLogRecord
  | CloudLogRecord
  | ProcessLogRecord
>

/**
 * Build roma over Google Chat, prove the credential, and start pulling.
 *
 * Resolves once roma is receiving. Everything that can refuse to start has
 * refused by then: the configuration is read whole, and the startup self-check
 * has driven a real Turn and agreed that auth resolves to the credential roma
 * means to run on.
 */
export async function startGoogleChatRoma(
  env: Environment = process.env,
  log: RomaLog = writeToStderr,
): Promise<Serving> {
  const {
    roma,
    channelEnv: chat,
    minterEnv,
    cloudEnv,
  } = readConfiguration(env, readChatEnv, readMinterEnv, readCloudEnv)
  const { shimDir, ...core } = roma

  // Application Default Credentials: a key file named by
  // GOOGLE_APPLICATION_CREDENTIALS, or the metadata server on a Google host.
  // Deliberately not roma's own mechanism — this one already exists, is already
  // documented, and is what the deployment's own tooling will have set up.
  const auth = new GoogleAuth({ scopes: [CHAT_SCOPE] })
  const client = await auth.getClient()
  const send: SendChatRequest = async ({ method, url, body }) => {
    const response = await client.request({ url, method, data: body })
    return response.data
  }
  // `arraybuffer` because the response is a file rather than JSON, and the
  // default would have the library parse it as one — which for a PNG means a
  // throw at best and a mangled string at worst.
  const download: DownloadChatMedia = async (url) => {
    const response = await client.request({ url, method: 'GET', responseType: 'arraybuffer' })
    return new Uint8Array(response.data as ArrayBuffer)
  }

  // The subscription is opened, not created. Chat publishes to a topic somebody
  // provisioned and roma reads a subscription somebody provisioned — see
  // `readChatEnv`, and the ticket that says provisioning is out of scope.
  const subscription = new PubSub({ projectId: chat.projectId }).subscription(chat.subscription, {
    flowControl: { maxMessages: chat.maxMessages },
    // How long a message may stay un-acknowledged while its Task runs. Set
    // rather than left to the library, because roma holds a message for the
    // whole of a Task and that is minutes — the default would give up on one
    // mid-Turn and have it delivered again alongside the run still going.
    maxExtensionTime: Duration.from({ minutes: chat.maxLeaseMinutes }),
  })

  // The one place a forge is named, and now the one place the agent's cloud is,
  // for the reason a Channel is named here and nowhere else: assembling roma
  // means saying what it is assembled out of, and `src/` proper is not allowed
  // to know any of the three answers. `src/github-containment.test.ts` and
  // `src/cloud-containment.test.ts` are what hold the rest of the tree to that.
  //
  // Note what the Cloud Reach's Minter is **not** given: the `GoogleAuth` above,
  // or anything else that would go looking for a credential. It is handed the
  // key `readCloudEnv` read from the path the deployment named, and nothing
  // else — because the resolution chain ends at the metadata server, and on a
  // Google host that is roma's own identity (ADR-0015 §4). The two credentials
  // on this page are deliberately unrelated: one is roma's, one is the agent's.
  return await serve({
    ...core,
    minting: {
      minter: new GitHubMinter(minterEnv),
      shimDir,
      gitConfig: gitConfig(),
      announce,
    },
    ...(cloudEnv === null
      ? {}
      : { cloud: { minter: new GoogleCloudMinter(cloudEnv), announce: announceCloud } }),
    channel: new GoogleChatAdapter({ api: new HttpChatApi({ send, download }), log }),
    transport: new PubSubTransport({ subscription, log }),
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
    serving = await startGoogleChatRoma(process.env, log)
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
