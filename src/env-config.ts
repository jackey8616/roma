import type { Credential } from './build-env.js'
import type { StartRomaOptions } from './startup.js'

/**
 * Everything a deployment tells roma about itself, short of the Channel.
 *
 * The Channel's own settings are not here and cannot be: what it takes to reach
 * one is that Channel's business, and naming any of it in the Core is the thing
 * the whole split exists to prevent. A Channel Adapter reads its own environment
 * in its own directory.
 */
export type RomaEnv = Pick<
  StartRomaOptions,
  | 'credential'
  | 'overflow'
  | 'workRoot'
  | 'auditRoot'
  | 'configDir'
  | 'model'
  | 'maxConcurrentTasks'
> & {
  /**
   * roma's own directory: the Credential Shim socket, and the gitconfig every
   * Session runs under.
   *
   * Named for the Shims rather than for the socket, because it holds both and a
   * name that mentioned one of them would go on being read as the whole of what
   * is in there. `ROMA_SHIM_DIR` is the variable, and the two agree.
   *
   * Not part of the `Pick` above because `startRoma` takes it inside `minting`,
   * alongside the two things only the composition root can supply — a Minter,
   * and the text of that gitconfig. This is the half of it an environment can
   * name.
   */
  readonly shimDir: string
}

/**
 * The environment did not say enough, or said something roma cannot use.
 *
 * Carries every problem rather than the first, for the reason
 * `StartupSelfCheckFailed` does: standing roma up means setting all of these at
 * once, and a refusal that named one at a time would turn that into a sequence
 * of boots.
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
 * Read the Core's settings, a Channel's, the Minter's and the Cloud Reach's, and
 * refuse once with what is wrong with any of them.
 *
 * One refusal rather than four, because they are one configuration: somebody
 * standing roma up sets all of it in one go, and being told about the missing
 * subscription only after fixing the missing audit root turns that into a
 * sequence of boots. Every other reader is passed in rather than named, and for
 * the same reason in each case — which Channel roma has, which forge it mints
 * against, and which cloud it reaches are not things the Core is allowed to
 * know.
 *
 * The cloud reader is the one that may legitimately find nothing: most
 * deployments have no Cloud Reach, and that is an answer rather than a problem.
 * It is a reader all the same, so that a *broken* one lands in this refusal
 * beside everything else.
 */
export function readConfiguration<ChannelEnv, MinterConfig, CloudConfig>(
  env: Environment,
  readChannelEnv: (env: Environment) => ChannelEnv,
  readMinterEnv: (env: Environment) => MinterConfig,
  readCloudEnv: (env: Environment) => CloudConfig | null,
): {
  roma: RomaEnv
  channelEnv: ChannelEnv
  minterEnv: MinterConfig
  cloudEnv: CloudConfig | null
} {
  const problems: string[] = []
  const roma = attempted(() => readRomaEnv(env), problems)
  const channelEnv = attempted(() => readChannelEnv(env), problems)
  const minterEnv = attempted(() => readMinterEnv(env), problems)
  // Null twice over, and the two are not distinguished: a reader that refused
  // has already put its problem in the list, and a deployment with no Cloud
  // Reach has nothing to report. Either way the refusal below is what decides
  // whether roma starts.
  const cloudEnv = attempted(() => readCloudEnv(env), problems)
  if (problems.length > 0) throw new ConfigurationMissing(problems)
  return {
    roma: certain(roma),
    channelEnv: certain(channelEnv),
    minterEnv: certain(minterEnv),
    cloudEnv,
  }
}

/**
 * A value that was only missing if the refusal above already fired.
 *
 * A check rather than a cast, because the invariant it rests on — that
 * `problems` being empty means every `required` found something — is one the
 * types cannot see and a later edit could quietly break. Throwing here would be
 * a bug in this file rather than a fact about the environment, which is why it
 * says so.
 */
export function certain<T>(value: T | null): T {
  if (value === null) throw new Error('configuration was read as complete while a part was missing')
  return value
}

/** Read one part of the configuration, keeping its problems rather than throwing. */
function attempted<T>(read: () => T, problems: string[]): T | null {
  try {
    return read()
  } catch (error) {
    // Only the incomplete-configuration case is collected. Anything else is a
    // reader that is broken rather than an environment that is, and swallowing
    // one would report a bug as a missing variable.
    if (!(error instanceof ConfigurationMissing)) throw error
    problems.push(...error.problems)
    return null
  }
}

/**
 * Read roma's own settings out of the environment.
 *
 * Environment variables rather than a file, because every one of these is
 * either a secret or a path that differs per host — which is what an environment
 * is for — and because a deployment already has to put the Shared Window token
 * somewhere roma can see it.
 *
 * Nothing here provisions anything or has a fallback that would quietly change
 * what roma runs on. A missing token is refused rather than defaulted to the
 * host's own login; a missing audit root is refused rather than put somewhere
 * under the working directories, which a weekly reclaim would delete; a missing
 * config dir is refused rather than left to Claude Code's own default, which is
 * under the `HOME` roma passes through — so every Session's Transcript would
 * land in the host user's `~/.claude/projects/`, mixed in with whatever Claude
 * Code that person runs themselves and in a directory roma never reclaims.
 * ADR-0005 makes the Transcript the only account of what an agent did, which is
 * a claim that needs roma to have named where it lives.
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

  const overflow = readOverflow(env, problems)
  const model = envValue(env, 'ROMA_MODEL')
  const maxConcurrentTasks = wholeNumber(env, 'ROMA_MAX_CONCURRENT_TASKS', problems)

  if (problems.length > 0) throw new ConfigurationMissing(problems)

  const credential: Credential = { kind: 'shared-window', oauthToken: certain(oauthToken) }
  // Spread rather than set to undefined: `exactOptionalPropertyTypes` aside, a
  // property present and undefined is not the same as one a caller never
  // mentioned, and `startRoma` has its own defaults for every one of these.
  return {
    credential,
    workRoot: certain(workRoot),
    auditRoot: certain(auditRoot),
    configDir: certain(configDir),
    shimDir: certain(shimDir),
    ...(overflow === null ? {} : { overflow }),
    ...(model === null ? {} : { model }),
    ...(maxConcurrentTasks === null ? {} : { maxConcurrentTasks }),
  }
}

/**
 * Metered billing, which exists only when both halves of it do.
 *
 * Both or neither, and never one: a key with no cap is a credential with nothing
 * bounding what it spends, which makes ADR-0002's "off by default" ceremony
 * rather than protection; a cap with no key would have roma offer a valve there
 * is nothing behind, which is a button somebody presses while already waiting.
 *
 * The key is read from a name of roma's own rather than from `ANTHROPIC_API_KEY`.
 * That name is set on developer machines and in CI images for reasons that have
 * nothing to do with roma, and reading it would turn metered billing on for a
 * whole deployment because a shell profile mentioned it — the same stray-key
 * failure the startup self-check exists to catch, arriving through roma's own
 * front door.
 */
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
 * One variable, or null where the environment does not really have it.
 *
 * Exported because a Channel Adapter reads its own environment in its own
 * directory and these three rules are roma's rather than any Channel's — a
 * second copy would drift, and the first thing to drift would be the empty-string
 * rule below, which is the one that is not obvious.
 */
export function envValue(env: Environment, name: string): string | null {
  const found = env[name]
  // An empty string is what a shell leaves behind when a variable was set from
  // something that turned out to be empty. Treated as a value it boots roma on
  // an empty token, which then fails as a credential problem rather than as the
  // deployment mistake it is.
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
