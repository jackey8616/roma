import { describe, expect, it } from 'vitest'
import { ContainmentRefused, dropRoot, type KeyFile, type RootSystem } from './drop-root.js'

const PEM: KeyFile = { variable: 'ROMA_EXAMPLE_KEY_FILE', path: '/run/secrets/example.pem' }
const JSON_KEY: KeyFile = { variable: 'ROMA_OTHER_KEY_FILE', path: '/run/secrets/other.json' }

/**
 * A host where everything goes right unless a test says otherwise: started as
 * root, SIGUSR1 disabled, the drop succeeds, the kernel marks roma
 * non-dumpable, and no key file is readable once roma is `node`.
 */
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

  it('leaves a process that was never root alone, and says the agent can reach its keys [fence:drop-root-not-root-is-reported]', () => {
    const { host, calls } = system({ uid: () => 1000 })

    const result = dropRoot([PEM], host)

    expect(calls).toEqual([])
    expect(result.dropped).toBe(false)
    if (!result.dropped) expect(result.reason).toMatch(/same uid/)
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
})
