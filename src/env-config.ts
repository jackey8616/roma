import type { Credential } from './build-env.js'
import { EFFORT_MENU, isPinnableEffort, ULTRACODE } from './effort-menu.js'
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
  | 'effort'
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
 * One Channel's own reader: its settings, or null where this deployment does not
 * serve that Channel at all.
 *
 * Null and a refusal are different answers, and keeping them apart is the whole
 * of what makes a Channel optional. A deployment that named none of a Channel's
 * variables serves another Channel and is complete; a deployment that named some
 * of them meant to serve this one, and left alone would get a roma that
 * subscribes to nothing and answers nobody on it. So a reader returns null only
 * for the first, and refuses for the second — the same rule `readOverflow`
 * already applies to the two halves of metered billing (ADR-0028).
 */
export type ReadChannelEnv<ChannelEnv> = (env: Environment) => ChannelEnv | null

/**
 * Whether this deployment named nothing at all of one Channel's configuration —
 * the first of `ReadChannelEnv`'s two answers, asked in one place.
 *
 * **Never hand it only the variables that are required.** Every variable that
 * Channel reads goes in, optional ones included: narrowed to the required ones,
 * somebody who set a lease minute or pointed an address at a proxy and forgot
 * the credential gets a roma that starts, serves that Channel to nobody, and
 * ignores the variable they did set. Whole, the same deployment is refused.
 */
export function unconfigured(env: Environment, names: readonly string[]): boolean {
  return names.every((name) => envValue(env, name) === null)
}

/**
 * Read the Core's settings, every Channel's, the Minter's, the Cloud Reach's and
 * the Document Reach's, and refuse once with what is wrong with any of them.
 *
 * One refusal rather than five, because they are one configuration: somebody
 * standing roma up sets all of it in one go, and being told about the missing
 * subscription only after fixing the missing audit root turns that into a
 * sequence of boots. Every other reader is passed in rather than named, and for
 * the same reason in each case — which Channels roma has, which forge it mints
 * against, which cloud it reaches and whose documents it writes are not things
 * the Core is allowed to know. That extends to their names: the Channels are a
 * record whose keys the composition root chose, so the refusal below can list
 * them without this file ever naming one.
 *
 * The Channels and the last two Reaches are the readers that may legitimately
 * find nothing. They differ in what nothing means. Most deployments have neither
 * Reach and that is an answer; a deployment with no Channel at all would boot,
 * subscribe to nothing and answer nobody, so **at least one is required** and
 * which one is the deployment's to pick.
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
  // Only where every Channel was silent rather than wrong. A reader that refused
  // has already said what is missing from the Channel the deployment plainly
  // meant to serve, and telling somebody they configured no Channel in the same
  // breath would send them to a second one they never wanted.
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
  const effort = readEffort(env, problems)
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
    ...(effort === null ? {} : { effort }),
    ...(maxConcurrentTasks === null ? {} : { maxConcurrentTasks }),
  }
}

/**
 * The Pinned Effort, or null where the deployment did not name one.
 *
 * **Validated locally, with no process involved.** Claude Code will not do it:
 * an unrecognised `--effort` warns on stderr and the process runs on the build's
 * own default, so a mistyped `ROMA_EFFORT` would be wrong about every Session
 * and every Audit Record with nothing stopping (ADR-0016's `bananas` row).
 *
 * Optional, unlike `ROMA_OVERFLOW_MONTHLY_CAP_USD`, because effort is money
 * already being spent under another name where the Overflow cap opens a new way
 * to spend it (ADR-0002).
 *
 * `ultracode` is accepted here and only here — it is `xhigh` plus workflow
 * orchestration, which turns one Task into a fleet, so it stays off the Effort
 * Menu. The Menu bounds Callers and never the operator.
 *
 * Compared exactly, never folded or trimmed: the repair would be roma guessing
 * at a value whose whole purpose is to be the thing somebody decided.
 */
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

/**
 * Metered billing, which exists only when both halves of it do.
 *
 * Both or neither, never one: a key with no cap spends unbounded, and a cap with
 * no key offers a valve with nothing behind it.
 *
 * Read from a name of roma's own, never `ANTHROPIC_API_KEY` — that is set on
 * developer machines and in CI images for unrelated reasons, and reading it
 * would turn metered billing on because a shell profile mentioned it.
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
