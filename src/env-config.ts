import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Credential } from './build-env.js'
import { CAVEMAN_MENU, isPinnableCaveman, OFF_MENU_WENYAN } from './caveman.js'
import { EFFORT_MENU, isPinnableEffort, ULTRACODE } from './effort-menu.js'
import type { StartRomaOptions } from './startup.js'

export type RomaEnv = Pick<
  StartRomaOptions,
  | 'credential'
  | 'overflow'
  | 'workRoot'
  | 'auditRoot'
  | 'configDir'
  | 'model'
  | 'effort'
  | 'caveman'
  | 'maxConcurrentTasks'
> & {
  readonly shimDir: string
}

export class ConfigurationMissing extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(
      ['roma refused to start — its configuration is incomplete.']
        .concat(problems.map((problem) => `  ${problem}`))
        .join('\n'),
    )
    this.name = 'ConfigurationMissing'
    this.problems = problems
  }
}

export type Environment = Readonly<Record<string, string | undefined>>

export type ReadChannelEnv<ChannelEnv> = (env: Environment) => ChannelEnv | null

export function unconfigured(env: Environment, names: readonly string[]): boolean {
  return names.every((name) => envValue(env, name) === null)
}

export function readConfiguration<
  Channels extends Record<string, ReadChannelEnv<unknown>>,
  MinterConfig,
  CloudConfig,
  DocumentConfig,
>(
  env: Environment,
  readChannelEnvs: Channels,
  readMinterEnv: (env: Environment) => MinterConfig,
  readCloudEnv: (env: Environment) => CloudConfig | null,
  readDocumentEnv: (env: Environment) => DocumentConfig | null,
): {
  roma: RomaEnv
  channels: { readonly [Name in keyof Channels]: ReturnType<Channels[Name]> }
  minterEnv: MinterConfig
  cloudEnv: CloudConfig | null
  documentEnv: DocumentConfig | null
} {
  const problems: string[] = []
  const roma = attempted(() => readRomaEnv(env), problems)

  const beforeChannels = problems.length
  const channels = Object.entries(readChannelEnvs).map(
    ([name, read]) => [name, attempted(() => read(env), problems)] as const,
  )
  if (problems.length === beforeChannels && channels.every(([, found]) => found === null)) {
    problems.push(
      `No Channel is configured — roma would start, subscribe to nothing and answer ` +
        `nobody. Configure at least one of: ${channels.map(([name]) => name).join(', ')}.`,
    )
  }

  const minterEnv = attempted(() => readMinterEnv(env), problems)
  const cloudEnv = attempted(() => readCloudEnv(env), problems)
  const documentEnv = attempted(() => readDocumentEnv(env), problems)
  if (problems.length > 0) throw new ConfigurationMissing(problems)
  return {
    roma: certain(roma),
    channels: Object.fromEntries(channels) as {
      [Name in keyof Channels]: ReturnType<Channels[Name]>
    },
    minterEnv: certain(minterEnv),
    cloudEnv,
    documentEnv,
  }
}

export function certain<T>(value: T | null): T {
  if (value === null) throw new Error('configuration was read as complete while a part was missing')
  return value
}

function within(root: string, path: string): boolean {
  const step = relative(resolve(root), resolve(path))
  return step === '' || (step !== '..' && !step.startsWith(`..${sep}`) && !isAbsolute(step))
}

function attempted<T>(read: () => T, problems: string[]): T | null {
  try {
    return read()
  } catch (error) {
    if (!(error instanceof ConfigurationMissing)) throw error
    problems.push(...error.problems)
    return null
  }
}

export function readRomaEnv(env: Environment): RomaEnv {
  const problems: string[] = []

  const oauthToken = required(env, 'CLAUDE_CODE_OAUTH_TOKEN', problems)
  const workRoot = required(env, 'ROMA_WORK_ROOT', problems)
  const auditRoot = required(env, 'ROMA_AUDIT_ROOT', problems)
  const configDir = required(env, 'ROMA_CLAUDE_CONFIG_DIR', problems)
  const shimDir = required(env, 'ROMA_SHIM_DIR', problems)
  if (workRoot !== null && auditRoot !== null && within(workRoot, auditRoot)) {
    problems.push(
      `ROMA_AUDIT_ROOT (${auditRoot}) is inside ROMA_WORK_ROOT (${workRoot}), whose seven-day ` +
        'reclaim would delete the Audit Records. Put it outside the work root.',
    )
  }

  const overflow = readOverflow(env, problems)
  const model = envValue(env, 'ROMA_MODEL')
  const effort = readEffort(env, problems)
  const caveman = readCaveman(env, problems)
  const maxConcurrentTasks = wholeNumber(env, 'ROMA_MAX_CONCURRENT_TASKS', problems)

  if (problems.length > 0) throw new ConfigurationMissing(problems)

  const credential: Credential = { kind: 'shared-window', oauthToken: certain(oauthToken) }
  return {
    credential,
    workRoot: certain(workRoot),
    auditRoot: certain(auditRoot),
    configDir: certain(configDir),
    shimDir: certain(shimDir),
    ...(overflow === null ? {} : { overflow }),
    ...(model === null ? {} : { model }),
    ...(effort === null ? {} : { effort }),
    ...(caveman === null ? {} : { caveman }),
    ...(maxConcurrentTasks === null ? {} : { maxConcurrentTasks }),
  }
}

function readEffort(env: Environment, problems: string[]): string | null {
  const found = envValue(env, 'ROMA_EFFORT')
  if (found === null) return null
  if (!isPinnableEffort(found)) {
    problems.push(
      `ROMA_EFFORT is "${found}", which is not an effort roma can pin. Set one of: ` +
        `${EFFORT_MENU.join(', ')} — or ${ULTRACODE}, which is the operator's alone. ` +
        `Claude Code would not refuse this: an unrecognised --effort warns on stderr and ` +
        `starts on its own default, so roma refuses it here instead.`,
    )
    return null
  }
  return found
}

function readCaveman(env: Environment, problems: string[]): string | null {
  const found = envValue(env, 'ROMA_CAVEMAN')
  if (found === null) return null
  if (!isPinnableCaveman(found)) {
    problems.push(
      `ROMA_CAVEMAN is "${found}", which is not a Caveman roma can pin. Set one of: ` +
        `${CAVEMAN_MENU.join(', ')} — or ${OFF_MENU_WENYAN.join(', ')}, which are the ` +
        `operator's alone. Nothing downstream would refuse this: the ruleset is roma's own ` +
        `text, assembled here and handed over rendered, so no Runtime ever sees the level.`,
    )
    return null
  }
  return found
}

function readOverflow(
  env: Environment,
  problems: string[],
): NonNullable<RomaEnv['overflow']> | null {
  const apiKey = envValue(env, 'ROMA_OVERFLOW_API_KEY')
  const cap = envValue(env, 'ROMA_OVERFLOW_MONTHLY_CAP_USD')
  if (apiKey === null && cap === null) return null

  if (apiKey === null) {
    problems.push(
      'ROMA_OVERFLOW_MONTHLY_CAP_USD is set but ROMA_OVERFLOW_API_KEY is not — a cap with no ' +
        'metered credential behind it caps nothing, and roma would offer Overflow it cannot run.',
    )
    return null
  }
  if (cap === null) {
    problems.push(
      'ROMA_OVERFLOW_API_KEY is set but ROMA_OVERFLOW_MONTHLY_CAP_USD is not — set the most ' +
        'Overflow may cost in one calendar month. There is no default: how much of your money ' +
        'roma may spend is not roma’s to decide.',
    )
    return null
  }

  const monthlyCapUsd = Number(cap)
  if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) {
    problems.push(
      `ROMA_OVERFLOW_MONTHLY_CAP_USD is "${cap}", which is not a positive number of US dollars.`,
    )
    return null
  }

  return { credential: { kind: 'overflow', apiKey }, monthlyCapUsd }
}

export function envValue(env: Environment, name: string): string | null {
  const found = env[name]
  return found === undefined || found === '' ? null : found
}

export function required(env: Environment, name: string, problems: string[]): string | null {
  const found = envValue(env, name)
  if (found === null) problems.push(`${name} is not set.`)
  return found
}

export function wholeNumber(env: Environment, name: string, problems: string[]): number | null {
  const found = envValue(env, name)
  if (found === null) return null
  const parsed = Number(found)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    problems.push(`${name} is "${found}", which is not a positive whole number.`)
    return null
  }
  return parsed
}
