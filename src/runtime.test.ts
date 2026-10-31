import { describe, expect, it } from 'vitest'
import { RUNTIME_NAMES, RUNTIMES, type Runtime } from './runtime.js'

describe('the name a Runtime is spelled with', () => {
  it('is one a reader can read, for every Runtime roma can name [fence:session-runtime-has-a-name]', () => {
    const why =
      'Every Runtime must have a name of its own in RUNTIME_NAMES (ADR-0025), and the table ' +
      'must stay keyed by Runtime so a Runtime added without one is a compile error. Loosened, ' +
      'a second Runtime prints in /usage, the Opening and /config as its raw id.'
    const names: Readonly<Record<Runtime, string>> = RUNTIME_NAMES

    for (const runtime of RUNTIMES) {
      expect(Object.hasOwn(names, runtime), `${why} (${runtime})`).toBe(true)
      expect(names[runtime], `${why} (${runtime})`).not.toBe(runtime)
      expect(names[runtime].trim(), `${why} (${runtime})`).not.toBe('')
    }
    expect(Object.keys(names).sort(), why).toEqual([...RUNTIMES].sort())
  })
})
