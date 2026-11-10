import { fileURLToPath } from 'node:url'
import { CLOUD_KEY_FILE_VAR, readCloudEnv } from '../cloud/env-config.js'
import { CLOUD_AGENT_HOSTS } from '../cloud/egress.js'
import { cloudReachFrom } from '../cloud/reach.js'
import type { CoreLogRecord } from '../core.js'
import { DOCUMENT_KEY_FILE_VAR, readDocumentEnv } from '../documents/env-config.js'
import { DOCUMENT_AGENT_HOSTS } from '../documents/egress.js'
import { documentReachFrom } from '../documents/reach.js'
import { realAuditSealSystem, sealAudit, type AuditSealSystem, type Sealed } from '../audit-seal.js'
import { dropRoot, realRootSystem, type Dropped, type RootSystem } from '../drop-root.js'
import { agentAllowlist } from '../egress/allowlist.js'
import type { Gateway } from '../egress/egress-proxy.js'
import { EGRESS_TOKEN_FILE_VAR, readEgressEnv } from '../egress/env-config.js'
import {
  EgressRefused,
  probeDirectEgress,
  routeThroughGateway,
  type DirectProbe,
} from '../egress/route.js'
import { envValue, launcherRootsOf, readConfiguration, type Environment } from '../env-config.js'
import { GITHUB_AGENT_HOSTS } from '../github/egress.js'
import { isolating, realLauncher, type Launcher } from '../launcher.js'
import { PRIVATE_KEY_FILE_VAR, readMinterEnv } from '../github/env-config.js'
import { githubReachFrom } from '../github/reach.js'
import { gitConfig } from '../github/shims.js'
import { writeToStderr, type OperatorLog } from '../operator-log.js'
import { serve, type ChannelBinding, type IngressLogRecord, type Serving } from '../serve.js'
import type { PoolLogRecord } from '../session-pool.js'
import type { ShimLogRecord } from '../shim-server.js'
import type {
  EgressOptions as StartRomaEgress,
  IsolationLogRecord,
  ReachLogRecord,
} from '../startup.js'
import type { SelfCheckLogRecord, StartupSelfCheckReport } from '../startup-self-check.js'
import { discordBinding, type DiscordLogRecord } from './discord/binding.js'
import { readDiscordEnv } from './discord/env-config.js'
import { googleChatBinding, type ChatLogRecord } from './google-chat/binding.js'
import { readChatEnv } from './google-chat/env-config.js'

const EXIT_SIGNALLED = 0
const EXIT_FAILED = 1

type ProcessLogRecord =
  | { readonly event: 'serving'; readonly selfCheck: StartupSelfCheckReport }
  | { readonly event: 'stopping'; readonly signal: NodeJS.Signals }
  | ({ readonly event: 'privileges' } & Dropped)
  | ({ readonly event: 'audit' } & Sealed)
  | {
      readonly event: 'egress'
      readonly gateway: string | null
      readonly allow: readonly string[] | null
    }

export interface EgressSystem {
  readonly probe: DirectProbe
  readonly route: (gateway: Gateway) => void
}

const REAL_EGRESS: EgressSystem = { probe: probeDirectEgress, route: routeThroughGateway }

type RomaLog = OperatorLog<
  | PoolLogRecord
  | CoreLogRecord
  | IngressLogRecord
  | ShimLogRecord
  | ChatLogRecord
  | DiscordLogRecord
  | ReachLogRecord
  | IsolationLogRecord
  | SelfCheckLogRecord
  | ProcessLogRecord
>

export async function startConfiguredRoma(
  env: Environment = process.env,
  log: RomaLog = writeToStderr,
  rootSystem: RootSystem = realRootSystem(),
  launcher: Launcher = realLauncher(),
  egressSystem: EgressSystem = REAL_EGRESS,
  auditSeal: AuditSealSystem = realAuditSealSystem(),
): Promise<Serving> {
  const { roma, channels, minterEnv, cloudEnv, documentEnv } = readConfiguration(
    env,
    { chat: readChatEnv, discord: readDiscordEnv },
    readMinterEnv,
    readCloudEnv,
    readDocumentEnv,
  )
  const egressEnv = readEgressEnv(env)
  const { shimDir, ...core } = roma
  if (rootSystem.uid() === 0) {
    await isolating('be told where Sessions live', async () =>
      launcher.writeRoots(launcherRootsOf(roma)),
    )
  }
  log({ event: 'privileges', ...dropRoot(keyFilesIn(env), rootSystem) })
  log({ event: 'audit', ...sealAudit(roma.auditRoot, auditSeal) })

  let egress: StartRomaEgress | undefined
  if (egressEnv === null) {
    log({ event: 'egress', gateway: null, allow: null })
  } else {
    const { gateway, extra } = egressEnv
    if (await egressSystem.probe()) throw new EgressRefused(gateway.url)
    egressSystem.route(gateway)
    const allow = agentAllowlist(
      GITHUB_AGENT_HOSTS,
      cloudEnv === null ? [] : CLOUD_AGENT_HOSTS,
      documentEnv === null ? [] : DOCUMENT_AGENT_HOSTS,
      extra,
    )
    log({ event: 'egress', gateway: gateway.url, allow })
    egress = { gateway, allow }
  }

  const bound: ChannelBinding[] = []
  if (channels.chat !== null) bound.push(await googleChatBinding(channels.chat, log))
  if (channels.discord !== null) bound.push(discordBinding(channels.discord, log))

  return await serve({
    ...core,
    reaches: {
      code: githubReachFrom(minterEnv),
      cloud: cloudReachFrom(cloudEnv),
      documents: documentReachFrom(documentEnv),
    },
    shims: { dir: shimDir, gitConfig: gitConfig() },
    launcher,
    channels: bound,
    ...(egress === undefined ? {} : { egress }),
    log,
  })
}

function keyFilesIn(env: Environment): { variable: string; path: string }[] {
  return [
    PRIVATE_KEY_FILE_VAR,
    CLOUD_KEY_FILE_VAR,
    DOCUMENT_KEY_FILE_VAR,
    EGRESS_TOKEN_FILE_VAR,
  ].flatMap((variable) => {
    const path = envValue(env, variable)
    return path === null ? [] : [{ variable, path }]
  })
}

export async function main(): Promise<void> {
  const log = writeToStderr
  let serving: Serving
  try {
    serving = await startConfiguredRoma(process.env, log)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(EXIT_FAILED)
  }

  log({ event: 'serving', selfCheck: serving.selfCheck })
  stopOn(['SIGTERM', 'SIGINT'], serving, log)
}

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
          process.stderr.write(
            `roma did not shut down cleanly: ${error instanceof Error ? error.message : String(error)}\n`,
          )
          process.exit(EXIT_FAILED)
        },
      )
    })
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main()
}
