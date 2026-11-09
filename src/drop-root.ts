import { accessSync, constants, statSync } from 'node:fs'

/** A key file the deployment named, by the variable it was named in. */
export interface KeyFile {
  readonly variable: string
  readonly path: string
}

/**
 * The parts of the operating system `dropRoot` asks about or changes, as a seam
 * a test substitutes at. `realRootSystem` is the only implementation that ships.
 */
export interface RootSystem {
  /** The real uid this process now runs as. */
  uid(): number
  /** Become `user`: its groups, then its gid, then its uid. Throws on failure. */
  becomeUser(user: string): void
  /**
   * Who owns this process's own `/proc` entry, or `null` where there is no
   * `/proc`. The kernel reports root here exactly when the process is not
   * dumpable, which is what keeps a same-uid process out of its environ and
   * its memory.
   */
  procOwner(): number | null
  /** Whether this process, as it now is, could open `path` for reading. */
  canRead(path: string): boolean
  /** The flags Node was started with, from the command line and `NODE_OPTIONS`. */
  nodeFlags(): readonly string[]
}

/** What `dropRoot` did, for the operator log. */
export type Dropped =
  | { readonly dropped: true; readonly user: string }
  | { readonly dropped: false; readonly reason: string }

/**
 * roma was started as root and could not make itself unreachable from the agent.
 * Every problem is named, so one refusal says everything that has to change.
 */
export class ContainmentRefused extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(
      [
        'roma refused to start — it could not keep its keys out of the agent’s reach.',
        ...problems.map((problem) => `  - ${problem}`),
      ].join('\n'),
    )
    this.name = 'ContainmentRefused'
    this.problems = problems
  }
}

/** The user roma serves as, and the agent runs as. The image creates it. */
export const SERVING_USER = 'node'

const DISABLE_SIGUSR1 = '--disable-sigusr1'

/**
 * Stop being root, once the key files have been read, and prove the agent can
 * no longer reach what roma holds (GHSA-v52v-hcv8-cr23, ADR-0032).
 *
 * The agent runs as roma's own uid, so the boundary is not a second uid. It is
 * what the kernel does when a root process changes uid: it marks the process
 * not dumpable, which closes `/proc/<roma>/environ`, `/proc/<roma>/mem` and
 * ptrace to every process without `CAP_SYS_PTRACE` — the agent included. The
 * key files themselves are kept out of reach by being unreadable to `node`.
 *
 * A process that was not started as root is left as it is and told why: that
 * is roma run from source, or an image started with `--user`, and in both the
 * agent can reach everything roma holds.
 *
 * Throws `ContainmentRefused` when roma was root and any of this did not hold.
 */
export function dropRoot(
  keyFiles: readonly KeyFile[],
  system: RootSystem = realRootSystem(),
): Dropped {
  if (system.uid() !== 0) {
    return {
      dropped: false,
      reason:
        'roma was not started as root, so the agent runs under the same uid with nothing ' +
        'between them: it can read every key file roma was given, roma’s environment and ' +
        'roma’s memory.',
    }
  }

  // Enforced by `fence:drop-root-requires-sigusr1-disabled`.
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
    // Enforced by `fence:drop-root-refuses-failed-drop`.
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

  // Enforced by `fence:drop-root-requires-non-dumpable`.
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

  // Enforced by `fence:drop-root-refuses-readable-key`.
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

/** The running process and the host it is on. */
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
