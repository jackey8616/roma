import { describe, expect, it } from 'vitest'
import { ContainmentRefused, dropRoot, type KeyFile, type RootSystem } from './drop-root.js'

const PEM: KeyFile = { variable: 'ROMA_EXAMPLE_KEY_FILE', path: '/run/secrets/example.pem' }
const JSON_KEY: KeyFile = { variable: 'ROMA_OTHER_KEY_FILE', path: '/run/secrets/other.json' }

function system(overrides: Partial<RootSystem> & { readonly readable?: readonly string[] } = {}) {
  const calls: string[] = []
  let uid = overrides.uid?.() ?? 0
  const host: RootSystem = {
    uid: () => uid,
    becomeUser: (user) => {
      calls.push(`becomeUser:${user}`)
      uid = 1000
    },
    procOwner: () => 0,
    canRead: (path) => (overrides.readable ?? []).includes(path),
    keyFileMode: () => ({ uid: 0, mode: 0o100400 }),
    nodeFlags: () => ['--disable-sigusr1'],
    ...overrides,
  }
  return { host, calls }
}

describe('dropRoot', () => {
  it('becomes node once the keys are read, and says so [fence:drop-root-drops-to-node]', () => {
    const { host, calls } = system()

    expect(dropRoot([PEM], host)).toEqual({ dropped: true, user: 'node' })
    expect(calls).toEqual(['becomeUser:node'])
  })

  it('refuses a process that was never root, which can keep no Session from another [fence:drop-root-refuses-when-not-root]', () => {
    const why =
      'ADR-0036: without root there is no Launcher to change uid, so every agent runs as ' +
      'roma and as each other, which is GHSA-mqhq-64x8-xj73 open. ADR-0032 let roma run on ' +
      'and log `dropped: false`; an operator who did not mean to would never find out.'
    const { host, calls } = system({ uid: () => 1000 })

    expect(() => dropRoot([PEM], host), why).toThrow(ContainmentRefused)
    expect(() => dropRoot([PEM], host), why).toThrow(/was not started as root/)
    expect(calls, why).toEqual([])
  })

  it('refuses when SIGUSR1 can still open an inspector [fence:drop-root-requires-sigusr1-disabled]', () => {
    const { host, calls } = system({ nodeFlags: () => [] })

    expect(() => dropRoot([PEM], host)).toThrow(ContainmentRefused)
    expect(() => dropRoot([PEM], host)).toThrow(/--disable-sigusr1/)
    expect(calls).toEqual([])
  })

  it('accepts --disable-sigusr1 from NODE_OPTIONS as well as the command line', () => {
    const { host } = system({ nodeFlags: () => ['--max-old-space-size=512', '--disable-sigusr1'] })

    expect(dropRoot([PEM], host).dropped).toBe(true)
  })

  it('refuses when the drop itself fails, naming why [fence:drop-root-refuses-failed-drop]', () => {
    const { host } = system({
      becomeUser: () => {
        throw new Error('EPERM, Operation not permitted')
      },
    })

    expect(() => dropRoot([PEM], host)).toThrow(/EPERM/)
  })

  it('refuses when roma is still root after the drop', () => {
    const { host } = system({ becomeUser: () => {} })

    expect(() => dropRoot([PEM], host)).toThrow(/still root/)
  })

  it('refuses when the kernel left roma dumpable [fence:drop-root-requires-non-dumpable]', () => {
    const fresh = () => system({ procOwner: () => 1000 }).host

    expect(() => dropRoot([PEM], fresh())).toThrow(ContainmentRefused)
    expect(() => dropRoot([PEM], fresh())).toThrow(/suid_dumpable/)
  })

  it('refuses when it cannot tell whether roma is dumpable', () => {
    const { host } = system({ procOwner: () => null })

    expect(() => dropRoot([PEM], host)).toThrow(/\/proc/)
  })

  it('refuses when node can still read a key file, naming every one [fence:drop-root-refuses-readable-key]', () => {
    const { host } = system({ readable: [PEM.path, JSON_KEY.path] })

    let refusal: unknown
    try {
      dropRoot([PEM, JSON_KEY], host)
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(ContainmentRefused)
    const message = (refusal as Error).message
    expect(message).toContain(`${PEM.variable} is "${PEM.path}"`)
    expect(message).toContain(`${JSON_KEY.variable} is "${JSON_KEY.path}"`)
    expect(message).toMatch(/0400/)
  })

  it('does not complain about a key file node cannot read', () => {
    const { host } = system({ readable: [JSON_KEY.path] })

    expect(() => dropRoot([PEM], host)).not.toThrow()
  })

  it('refuses a key a Seat could own or read, though node cannot read it [fence:drop-root-requires-root-owned-key]', () => {
    const why =
      'GHSA-v52v-hcv8-cr23: agents run as Seat uids 20000-20015, not as node, so "node cannot ' +
      'read it" is not "no agent can". A 0400 key owned by uid 20000 passed that check and ' +
      'Seat 0 read it. Only root ownership with no group or other bits keeps every Seat out.'
    const cases = [
      { uid: 20000, mode: 0o100400 },
      { uid: 0, mode: 0o100440 },
      { uid: 0, mode: 0o100404 },
    ]
    for (const found of cases) {
      const { host, calls } = system({ keyFileMode: () => found })

      expect(() => dropRoot([PEM], host), why).toThrow(/owned by root/)
      expect(calls, why).toEqual(['becomeUser:node'])
      expect(() => dropRoot([PEM], system({ keyFileMode: () => found }).host), why).toThrow(
        ContainmentRefused,
      )
    }
  })

  it('names every key that is not root-owned 0400, with its owner and mode', () => {
    const { host } = system({
      keyFileMode: (path) =>
        path === PEM.path ? { uid: 20003, mode: 0o100400 } : { uid: 0, mode: 0o100644 },
    })

    let refusal: unknown
    try {
      dropRoot([PEM, JSON_KEY], host)
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(ContainmentRefused)
    const message = (refusal as Error).message
    expect(message).toMatch(/ROMA_EXAMPLE_KEY_FILE.*uid 20003 with mode 0400/)
    expect(message).toMatch(/ROMA_OTHER_KEY_FILE.*uid 0 with mode 0644/)
  })

  it('accepts a root-owned 0400 key, and one that is 0600', () => {
    for (const mode of [0o100400, 0o100600]) {
      const { host } = system({ keyFileMode: () => ({ uid: 0, mode }) })

      expect(dropRoot([PEM], host).dropped).toBe(true)
    }
  })

  it('refuses a key roma reads after the drop unless only node can read it [fence:drop-root-requires-node-only-served-key]', () => {
    const why =
      'GOOGLE_APPLICATION_CREDENTIALS is read by Google libraries after the drop, so it stays ' +
      "node's. Since ADR-0036 no agent is node, so a 0644 key is no longer one the agent " +
      'reads anyway: it is one every Seat reads and none needs to.'
    const GOOGLE: KeyFile = {
      variable: 'GOOGLE_APPLICATION_CREDENTIALS',
      path: '/run/secrets/g.json',
    }
    const refusing = [
      { uid: 1000, mode: 0o100644 },
      { uid: 1000, mode: 0o100440 },
      { uid: 20000, mode: 0o100400 },
      { uid: 0, mode: 0o100444 },
    ]
    for (const found of refusing) {
      const { host } = system({
        keyFileMode: (path) => (path === GOOGLE.path ? found : { uid: 0, mode: 0o100400 }),
      })

      expect(() => dropRoot([PEM], host, [GOOGLE]), why).toThrow(
        /GOOGLE_APPLICATION_CREDENTIALS.*owned by node/,
      )
    }

    const { host } = system({
      keyFileMode: (path) =>
        path === GOOGLE.path ? { uid: 1000, mode: 0o100400 } : { uid: 0, mode: 0o100400 },
    })
    expect(dropRoot([PEM], host, [GOOGLE]).dropped, why).toBe(true)
  })
})
