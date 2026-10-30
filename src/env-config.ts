import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Credential } from './build-env.js'
import { CAVEMAN_MENU, isPinnableCaveman, OFF_MENU_WENYAN } from './caveman.js'
import { EFFORT_MENU, isPinnableEffort, ULTRACODE } from './effort-menu.js'
import type { StartRomaOptions } from './startup.js'

/**
 * Everything a deployment tells roma about itself, short of the Channel: a
 * Channel Adapter reads its own environment in its own directory.
 */
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
  /**
   * roma's own directory, `ROMA_SHIM_DIR`: the Credential Shim socket, and the
   * gitconfig every Session runs under. Named for the Shims rather than the
   * socket because it holds both.
   *
   * `startRoma` takes it inside `minting`, beside what only the composition root
   * can supply (a Minter, and the text of that gitconfig).
   */
  readonly shimDir: string
}

/**
 * The environment did not say enough, or said something roma cannot use.
 * Carries every problem rather than the first: standing roma up means setting all
 * of these at once, and a refusal that named one at a time would turn that into
 * a sequence of boots.
 */
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

/** What the host is offering, as `process.env` shaped. */
export type Environment = Readonly<Record<string, string | undefined>>

/**
 * One Channel's own reader: its settings, or null where this deployment does not
 * serve that Channel at all. Null only where the deployment named none of the
 * Channel's variables, and a refusal where it named some of them.
 * Enforced by `fence:env-a-channel-named-is-served-or-refused`.
 */
export type ReadChannelEnv<ChannelEnv> = (env: Environment) => ChannelEnv | null

/**
 * Whether this deployment named nothing at all of one Channel's configuration:
 * the first of `ReadChannelEnv`'s two answers. Every variable that Channel reads
 * goes in, optional ones included.
 * Enforced by `fence:env-a-channel-named-is-served-or-refused`.
 */
export function unconfigured(env: Environment, names: readonly string[]): boolean {
  return names.every((name) => envValue(env, name) === null)
}

/**
 * Read the Core's settings, every Channel's, the Minter's, the Cloud Reach's and
 * the Document Reach's, and refuse once with what is wrong with any of them.
 * Every reader but the Core's is passed in, and the Channels are named by the
 * keys of `readChannelEnvs`.
 *
 * The Channels and the last two Reaches may find nothing. Either Reach may be
 * absent, but **at least one Channel is required**: with none, roma would boot,
 * subscribe to nothing and answer nobody.
 */
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
  // Enforced by `fence:env-a-refused-channel-is-not-sent-elsewhere`.
  if (problems.length === beforeChannels && channels.every(([, found]) => found === null)) {
    problems.push(
      `No Channel is configured — roma would start, subscribe to nothing and answer ` +
        `nobody. Configure at least one of: ${channels.map(([name]) => name).join(', ')}.`,
    )
  }

  const minterEnv = attempted(() => readMinterEnv(env), problems)
  // Null twice over, and the two are not distinguished: a reader that refused
  // has already put its problem in the list, and a deployment with no Cloud
  // Reach has nothing to report. Either way the refusal below is what decides
  // whether roma starts.
  const cloudEnv = attempted(() => readCloudEnv(env), problems)
  const documentEnv = attempted(() => readDocumentEnv(env), problems)
  if (problems.length > 0) throw new ConfigurationMissing(problems)
  return {
    roma: certain(roma),
    // `Object.fromEntries` has no way to say that the keys it returns are the
    // keys it was handed, which is the whole of what this stands in for.
    channels: Object.fromEntries(channels) as {
      [Name in keyof Channels]: ReturnType<Channels[Name]>
    },
    minterEnv: certain(minterEnv),
    cloudEnv,
    documentEnv,
  }
}

/**
 * A value that was only missing if the refusal above already fired. Throwing
 * here is a bug in the reader rather than a fact about the environment.
 * Enforced by `fence:env-certain-not-a-cast`.
 */
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
    // Enforced by `fence:env-a-broken-reader-is-not-a-missing-variable`.
    if (!(error instanceof ConfigurationMissing)) throw error
    problems.push(...error.problems)
    return null
  }
}

/**
 * Read roma's own settings out of the environment: environment variables rather
 * than a file, because every one is a secret or a path that differs per host.
 * Nothing here provisions anything or has a fallback that would quietly change
 * what roma runs on. Enforced by `fence:env-no-fallback-for-what-cannot-be-lost`.
 */
export function readRomaEnv(env: Environment): RomaEnv {
  const problems: string[] = []

  const oauthToken = required(env, 'CLAUDE_CODE_OAUTH_TOKEN', problems)
  const workRoot = required(env, 'ROMA_WORK_ROOT', problems)
  const auditRoot = required(env, 'ROMA_AUDIT_ROOT', problems)
  const configDir = required(env, 'ROMA_CLAUDE_CONFIG_DIR', problems)
  // Required here and defaulted in the image, which is the work root's shape
  // rather than the audit root's — and on the rule the image already states:
  // default what is lost by design, refuse what cannot be lost. A socket holds
  // nothing and is recreated every boot. It is a variable at all rather than a
  // constant because running roma from source on a developer's machine is a
  // stated consequence of ADR-0008, and a fixed system path is not writable
  // there.
  const shimDir = required(env, 'ROMA_SHIM_DIR', problems)
  // Enforced by `fence:env-audit-root-outside-the-work-root`.
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
  // Enforced by `fence:env-unset-settings-are-absent`.
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

/** Enforced by `fence:env-effort-compared-exactly`. */
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

/** Enforced by `fence:env-caveman-compared-exactly`. */
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

/** Enforced by `fence:env-overflow-whole-and-roma-own`. */
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

/**
 * One variable, or null where the environment does not really have it; every
 * reader of the environment goes through it.
 * Enforced by `fence:env-read-through-env-value`.
 */
export function envValue(env: Environment, name: string): string | null {
  const found = env[name]
  // Enforced by `fence:env-empty-is-unset`.
  return found === undefined || found === '' ? null : found
}

/** One variable roma will not start without. Notes it as missing rather than throwing. */
export function required(env: Environment, name: string, problems: string[]): string | null {
  const found = envValue(env, name)
  if (found === null) problems.push(`${name} is not set.`)
  return found
}

/** One optional count. Null where it is unset, and a problem where it is nonsense. */
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
