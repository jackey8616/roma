import { accessSync, constants, statSync } from 'node:fs'

export interface KeyFile {
  readonly variable: string
  readonly path: string
}

export interface RootSystem {
  uid(): number
  becomeUser(user: string): void
  procOwner(): number | null
  canRead(path: string): boolean
  nodeFlags(): readonly string[]
}

export type Dropped = { readonly dropped: true; readonly user: string }

export class ContainmentRefused extends Error {
  readonly problems: readonly string[]

  constructor(
    problems: readonly string[],
    headline = 'roma refused to start — it could not keep its keys out of the agent’s reach.',
  ) {
    super([headline, ...problems.map((problem) => `  - ${problem}`)].join('\n'))
    this.name = 'ContainmentRefused'
    this.problems = problems
  }
}

export const SERVING_USER = 'node'

const DISABLE_SIGUSR1 = '--disable-sigusr1'

export function dropRoot(
  keyFiles: readonly KeyFile[],
  system: RootSystem = realRootSystem(),
): Dropped {
  if (system.uid() !== 0) {
    throw new ContainmentRefused([
      'roma was not started as root, so there is no Launcher to give each Session a Seat of ' +
        'its own: every agent would run as roma and as each other, reading every key file, ' +
        'every Working Directory and every Transcript (ADR-0036). Run roma as the image does.',
    ])
  }

  if (!system.nodeFlags().includes(DISABLE_SIGUSR1)) {
    throw new ContainmentRefused([
      `Node was started without ${DISABLE_SIGUSR1}. The agent shares roma’s uid and may ` +
        'signal it, and SIGUSR1 opens an inspector on 127.0.0.1:9229 that reads roma’s memory ' +
        `whatever the kernel says. Start roma as \`node ${DISABLE_SIGUSR1} …\`, as the image does.`,
    ])
  }

  try {
    system.becomeUser(SERVING_USER)
  } catch (error) {
    throw new ContainmentRefused([
      `roma could not become ${SERVING_USER}: ${error instanceof Error ? error.message : String(error)}. ` +
        'It needs CAP_SETUID and CAP_SETGID at boot, which Docker grants root by default; ' +
        'with --cap-drop=ALL, add them back with --cap-add=SETUID --cap-add=SETGID.',
    ])
  }

  const problems: string[] = []
  if (system.uid() === 0) {
    problems.push(`roma asked to become ${SERVING_USER} and is still root.`)
  }

  const owner = system.procOwner()
  if (owner === null) {
    problems.push(
      'There is no /proc to confirm that roma is not dumpable, so nothing shows the agent is ' +
        'kept out of roma’s memory.',
    )
  } else if (owner !== 0) {
    problems.push(
      'roma changed uid and the kernel left it dumpable, so the agent could read roma’s ' +
        'environment and memory. This host sets fs.suid_dumpable to 1; set it to 0 or 2.',
    )
  }

  for (const { variable, path } of keyFiles) {
    if (system.canRead(path)) {
      problems.push(
        `${variable} is "${path}", which ${SERVING_USER} — and so the agent — can still read. ` +
          'Make it 0400 and owned by root (or any uid but 1000); roma reads it as root ' +
          'before it drops.',
      )
    }
  }

  if (problems.length > 0) throw new ContainmentRefused(problems)
  return { dropped: true, user: SERVING_USER }
}

export function realRootSystem(): RootSystem {
  return {
    uid: () => process.getuid?.() ?? -1,
    becomeUser: (user) => {
      if (
        process.setgroups === undefined ||
        process.setgid === undefined ||
        process.setuid === undefined
      ) {
        throw new Error('this platform cannot change user')
      }
      process.setgroups([])
      process.setgid(user)
      process.setuid(user)
    },
    procOwner: () => {
      try {
        return statSync(`/proc/${process.pid}/environ`).uid
      } catch {
        return null
      }
    },
    canRead: (path) => {
      try {
        accessSync(path, constants.R_OK)
        return true
      } catch {
        return false
      }
    },
    nodeFlags: () => [
      ...process.execArgv,
      ...(process.env['NODE_OPTIONS'] ?? '').split(/\s+/).filter((flag) => flag !== ''),
    ],
  }
}
