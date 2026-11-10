import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  exposedAncestors,
  realAuditSealSystem,
  sealAudit,
  type AuditSealSystem,
  type Inode,
} from './audit-seal.js'
import { ContainmentRefused } from './drop-root.js'

const ROMA = 1000
const SEAT = { uid: 20000, gid: 20000 }
const ROOT = '/var/lib/roma/audit'

const directory = (uid: number, mode: number, gid = uid): Inode => ({
  uid,
  gid,
  mode: 0o40000 | mode,
})

const STANDARD: Readonly<Record<string, Inode>> = {
  '/': directory(0, 0o755),
  '/var': directory(0, 0o755),
  '/var/lib': directory(0, 0o755),
  '/var/lib/roma': directory(ROMA, 0o755),
  [ROOT]: directory(ROMA, 0o700),
}

function system(
  overrides: Partial<AuditSealSystem> & {
    readonly tree?: Readonly<Record<string, Inode>>
    readonly mounts?: readonly string[]
  } = {},
) {
  const tightened: string[] = []
  const tree = overrides.tree ?? STANDARD
  const host: AuditSealSystem = {
    self: () => ({ uid: ROMA, gid: ROMA }),
    seats: () => [SEAT, { uid: 20001, gid: 20001 }],
    makeDirectory: () => {},
    inspect: (path) => tree[path] ?? null,
    owner: (path) => tree[path]?.uid ?? null,
    mountPoint: (path) => (overrides.mounts ?? []).includes(path),
    realPath: (path) => path,
    tighten: (path, mode) => tightened.push(`${path}:${mode.toString(8)}`),
    ...overrides,
  }
  return { host, tightened }
}

describe('sealAudit', () => {
  it('passes a root only roma can open, under directories no Seat can write', () => {
    const { host, tightened } = system()

    expect(sealAudit(ROOT, host)).toEqual({ sealed: true, tightened: false })
    expect(tightened).toEqual([])
  })

  it('closes an audit root an earlier roma left open to every Seat [fence:audit-seal-tightens-to-owner-only]', () => {
    const { host, tightened } = system({
      tree: { ...STANDARD, [ROOT]: directory(ROMA, 0o755) },
    })

    expect(sealAudit(ROOT, host)).toEqual({ sealed: true, tightened: true })
    expect(tightened).toEqual([`${ROOT}:700`])
  })

  it('refuses an audit root roma does not own, naming the chown [fence:audit-seal-refuses-foreign-owner]', () => {
    const { host, tightened } = system({
      tree: { ...STANDARD, [ROOT]: directory(SEAT.uid, 0o755) },
    })

    expect(() => sealAudit(ROOT, host)).toThrow(ContainmentRefused)
    expect(() => sealAudit(ROOT, host)).toThrow(/chown -R 1000:1000/)
    expect(tightened).toEqual([])
  })

  it('refuses when there are no Seats to judge against', () => {
    const { host } = system({ seats: () => [] })

    expect(() => sealAudit(ROOT, host)).toThrow(/roma-seat-NN/)
  })

  it('refuses when a Seat could rename any directory above the records away [fence:audit-seal-refuses-seat-writable-ancestor]', () => {
    const root = '/srv/shared/roma/audit'
    const { host } = system({
      tree: {
        '/': directory(0, 0o755),
        '/srv': directory(0, 0o755),
        '/srv/shared': directory(0, 0o777),
        '/srv/shared/roma': directory(ROMA, 0o755),
        [root]: directory(ROMA, 0o700),
      },
    })

    expect(() => sealAudit(root, host)).toThrow(ContainmentRefused)
    expect(() => sealAudit(root, host)).toThrow(
      '/srv/shared/roma can be renamed away by a Seat, because /srv/shared is writable by one',
    )
  })

  it('follows a link to where the records really are [fence:audit-seal-follows-links]', () => {
    const real = '/home/seat/audit'
    const { host } = system({
      realPath: (path) => (path === ROOT ? real : path),
      tree: {
        ...STANDARD,
        '/home': directory(0, 0o755),
        '/home/seat': directory(SEAT.uid, 0o755),
        [real]: directory(ROMA, 0o700),
      },
    })

    expect(() => sealAudit(ROOT, host)).toThrow('/home/seat/audit can be renamed away')
  })
})

describe('exposedAncestors', () => {
  const tree = (extra: Readonly<Record<string, Inode>>) => ({
    '/': directory(0, 0o755),
    ...extra,
  })

  it('judges a Seat by its own uid, its own group and the world bits', () => {
    const at = (parent: Inode) =>
      exposedAncestors(
        '/p/audit',
        system({ tree: tree({ '/p': parent, '/p/audit': directory(ROMA, 0o700) }) }).host,
        [SEAT],
      ).length

    expect(at(directory(SEAT.uid, 0o755))).toBe(1)
    expect(at(directory(0, 0o775, SEAT.gid))).toBe(1)
    expect(at(directory(0, 0o757))).toBe(1)
    expect(at(directory(ROMA, 0o755))).toBe(0)
    expect(at(directory(0, 0o775, ROMA))).toBe(0)
  })

  it('passes a mount point, which rename refuses, under a directory a Seat can write', () => {
    const { host } = system({
      tree: tree({ '/p': directory(0, 0o777), '/p/volume': directory(ROMA, 0o700) }),
      mounts: ['/p/volume'],
    })

    expect(exposedAncestors('/p/volume', host, [SEAT])).toEqual([])
  })

  it('passes a sticky directory unless a Seat owns the child or the directory', () => {
    const at = (child: number, parent = 0) =>
      exposedAncestors(
        '/tmp/audit',
        system({
          tree: tree({ '/tmp': directory(parent, 0o1777), '/tmp/audit': directory(child, 0o700) }),
        }).host,
        [SEAT],
      ).length

    expect(at(ROMA)).toBe(0)
    expect(at(SEAT.uid)).toBe(1)
    expect(at(ROMA, SEAT.uid)).toBe(1)
  })
})

describe('the real audit seal system', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('makes a missing audit root owner-only, and finds a world-writable directory above it', () => {
    const base = mkdtempSync(join(tmpdir(), 'roma-audit-seal-'))
    dirs.push(base)
    const open = join(base, 'open')
    mkdirSync(open)
    chmodSync(open, 0o777)
    const root = join(open, 'roma', 'audit')
    const real = realAuditSealSystem()

    real.makeDirectory(root)
    const found = exposedAncestors(root, real, [{ uid: 4242, gid: 4242 }])

    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(found.map(({ path }) => path)).toContain(join(open, 'roma'))
  })
})
