import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ContainmentRefused } from './drop-root.js'

const SEALED_MODE = 0o700
const SEAT_USER = /^roma-seat-\d{2}$/

const HEADLINE =
  'roma refused to start — it could not keep the Audit Records out of every Seat’s reach.'

export interface Ids {
  readonly uid: number
  readonly gid: number
}

export interface Inode {
  readonly uid: number
  readonly gid: number
  readonly mode: number
}

export interface AuditEntry {
  readonly name: string
  readonly kind: 'file' | 'link' | 'other'
  readonly uid: number
  readonly links: number
}

export interface AuditSealSystem {
  self(): Ids
  seats(): readonly Ids[]
  makeDirectory(path: string): void
  inspect(path: string): Inode | null
  owner(path: string): number | null
  mountPoint(path: string): boolean
  realPath(path: string): string
  entries(path: string): readonly AuditEntry[]
  tighten(path: string, mode: number): void
}

export interface Sealed {
  readonly sealed: true
  readonly tightened: boolean
}

export interface Exposed {
  readonly path: string
  readonly parent: string
  readonly seatOwned?: boolean
}

export function sealAudit(
  auditRoot: string,
  system: AuditSealSystem = realAuditSealSystem(),
): Sealed {
  const self = system.self()
  const seats = system.seats()
  if (seats.length === 0) {
    throw new ContainmentRefused(
      [
        'There are no roma-seat-NN users, so roma cannot tell whether an agent could reach the ' +
          'Audit Records. Run roma as the image does.',
      ],
      HEADLINE,
    )
  }

  system.makeDirectory(auditRoot)
  const root = system.realPath(auditRoot)
  if (root !== resolve(auditRoot)) {
    throw new ContainmentRefused(
      [
        `${auditRoot} passes through a symbolic link and resolves to ${root}. roma reads the ` +
          'records by that path every time, and a link on the way is one more thing a Seat ' +
          'could swap for a ledger of its own. Set ROMA_AUDIT_ROOT to the real directory.',
      ],
      HEADLINE,
    )
  }
  const found = system.inspect(root)
  if (found === null || found.uid !== self.uid) {
    throw new ContainmentRefused(
      [
        `${auditRoot} is owned by ${found === null ? 'nobody roma can see' : `uid ${found.uid}`}, ` +
          `not by roma (uid ${self.uid}). roma writes the Audit Records itself and seals the ` +
          `directory so no Seat can open it; chown -R ${self.uid}:${self.gid} it.`,
      ],
      HEADLINE,
    )
  }

  const strays = system
    .entries(root)
    .filter(({ kind, uid, links }) => kind !== 'file' || uid !== self.uid || links !== 1)
  if (strays.length > 0) {
    throw new ContainmentRefused(
      strays.map(
        ({ name, kind, uid, links }) =>
          `${join(root, name)} is ${kind === 'link' ? 'a symbolic link' : kind === 'other' ? 'not a regular file' : uid !== self.uid ? `owned by uid ${uid}` : `one of ${links} hard links`}. ` +
          'The seal closes the directory, not what a name in it points at; every month has to ' +
          `be a plain file of roma's own (uid ${self.uid}). Move it out, or replace it with a copy.`,
      ),
      HEADLINE,
    )
  }

  const tightened = (found.mode & 0o7777) !== SEALED_MODE
  if (tightened) system.tighten(root, SEALED_MODE)

  const exposed = exposedAncestors(auditRoot, system, seats)
  if (exposed.length > 0) {
    throw new ContainmentRefused(
      exposed.map(({ path, parent, seatOwned }) =>
        seatOwned === true
          ? `${path} can be cut off or renamed away by a Seat, because ${parent} is owned by ` +
            'one, which can change its mode whatever it is now — a mount point included. ' +
            'Put the audit root under directories owned by root or by roma.'
          : `${path} can be renamed away by a Seat, because ${parent} is writable by one and ` +
            `${path} is not a mount point; an agent could put a ledger of its own where the ` +
            'Audit Records were. Put the audit root on its own mount, or under directories no ' +
            'Seat can write.',
      ),
      HEADLINE,
    )
  }

  return { sealed: true, tightened }
}

export function exposedAncestors(
  auditRoot: string,
  system: Pick<AuditSealSystem, 'inspect' | 'owner' | 'mountPoint' | 'realPath'>,
  seats: readonly Ids[],
): Exposed[] {
  const isSeat = (uid: number | undefined) => seats.some((seat) => seat.uid === uid)
  const seatCanWrite = ({ uid, gid, mode }: Inode) =>
    seats.some((seat) =>
      uid === seat.uid
        ? (mode & 0o200) !== 0
        : gid === seat.gid
          ? (mode & 0o020) !== 0
          : (mode & 0o002) !== 0,
    )

  const found = new Map<string, Exposed>()
  for (const path of new Set([resolve(auditRoot), system.realPath(auditRoot)])) {
    let child = path
    for (let parent = dirname(child); parent !== child; child = parent, parent = dirname(child)) {
      const above = system.inspect(parent)
      if (above !== null && isSeat(above.uid)) {
        found.set(child, { path: child, parent, seatOwned: true })
        continue
      }
      if (above === null || !seatCanWrite(above) || system.mountPoint(child)) continue
      const sticky = (above.mode & 0o1000) !== 0
      if (sticky && !isSeat(system.owner(child) ?? undefined) && !isSeat(above.uid)) continue
      found.set(child, { path: child, parent })
    }
  }
  return [...found.values()]
}

export function realAuditSealSystem(): AuditSealSystem {
  return {
    self: () => ({ uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 }),
    seats: () => {
      let passwd: string
      try {
        passwd = readFileSync('/etc/passwd', 'utf8')
      } catch {
        return []
      }
      return passwd.split('\n').flatMap((line) => {
        const [name, , uid, gid] = line.split(':')
        return name !== undefined && SEAT_USER.test(name) && uid !== undefined && gid !== undefined
          ? [{ uid: Number(uid), gid: Number(gid) }]
          : []
      })
    },
    makeDirectory: (path) => {
      mkdirSync(path, { recursive: true, mode: SEALED_MODE })
    },
    inspect: (path) => {
      try {
        const { uid, gid, mode } = statSync(path)
        return { uid, gid, mode }
      } catch {
        return null
      }
    },
    owner: (path) => {
      try {
        return lstatSync(path).uid
      } catch {
        return null
      }
    },
    mountPoint: (() => {
      let mounts: ReadonlySet<string> | null | undefined
      return (path: string) => {
        mounts ??= mountPoints()
        if (mounts !== null) return mounts.has(path)
        try {
          return lstatSync(path).dev !== statSync(dirname(path)).dev
        } catch {
          return false
        }
      }
    })(),
    realPath: (path) => {
      try {
        return realpathSync(path)
      } catch {
        return resolve(path)
      }
    },
    entries: (path) =>
      readdirSync(path).map((name) => {
        const found = lstatSync(join(path, name))
        return {
          name,
          kind: found.isSymbolicLink() ? 'link' : found.isFile() ? 'file' : 'other',
          uid: found.uid,
          links: found.nlink,
        }
      }),
    tighten: (path, mode) => chmodSync(path, mode),
  }
}

function mountPoints(): ReadonlySet<string> | null {
  let mountinfo: string
  try {
    mountinfo = readFileSync('/proc/self/mountinfo', 'utf8')
  } catch {
    return null
  }
  return new Set(
    mountinfo
      .split('\n')
      .map((line) => line.split(' ')[4])
      .filter((field) => field !== undefined)
      .map((field) =>
        field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
          String.fromCharCode(parseInt(octal, 8)),
        ),
      ),
  )
}
