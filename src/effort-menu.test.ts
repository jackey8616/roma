import { describe, expect, it } from 'vitest'
import { readCommand } from './commands.js'
import {
  EFFORT_MENU,
  EFFORT_NAMES,
  EFFORT_NOT_APPLIED,
  isPinnableEffort,
  readEffortRequest,
  takesEffort,
  ULTRACODE,
  type EffortRequest,
} from './effort-menu.js'
import { MENU } from './model-menu.js'

function read(text: string): EffortRequest | null {
  const command = readCommand(text)
  return command?.command === 'effort' ? readEffortRequest(command.argument) : null
}

describe('reading an /effort message', () => {
  it('recognises every level on the Menu', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(read(`/effort ${level}`)).toEqual({ kind: 'chosen', level })
    }
  })

  it('reads default as a name of its own rather than as a level', () => {
    expect(read('/effort default')).toEqual({ kind: 'default' })
  })

  it('refuses ultracode from a Caller, as it refuses any other name [fence:menu-effort-holds-back-ultracode]', () => {
    const why =
      '`ultracode` must stay off the Effort Menu, reachable only through ROMA_EFFORT (ADR-0016). ' +
      'It is xhigh plus dynamic workflow orchestration, which turns one Task into a fleet on a ' +
      'window everybody shares, paid for by everybody else in the thread.'
    expect(read(`/effort ${ULTRACODE}`), why).toEqual({ kind: 'unknown', name: ULTRACODE })
    expect(EFFORT_MENU, why).not.toContain(ULTRACODE)
  })

  it('does not offer auto, which cannot be pinned [fence:menu-effort-offers-no-auto]', () => {
    const why =
      '`auto` must stay off the Effort Menu (ADR-0016). `--effort auto` is rejected by the ' +
      "CLI's own parser, so the only way to offer it is to omit --effort, which reopens the " +
      'settings file every Session shares and that passing --effort on every spawn closes.'
    expect(read('/effort auto'), why).toEqual({ kind: 'unknown', name: 'auto' })
    expect(EFFORT_MENU, why).not.toContain('auto')
  })

  it('does not inherit the build’s own alias for medium', () => {
    expect(read('/effort med')).toEqual({ kind: 'unknown', name: 'med' })
  })

  it('refuses a level roma does not offer, and says which [fence:menu-effort-unknown-is-refused]', () => {
    const why =
      'An /effort argument that is not on the Effort Menu must be read as unknown and refused, ' +
      'never passed on as work (ADR-0016, as ADR-0014 for /model). The Caller Marker goes ' +
      'above the message, so Claude Code never sees a command and somebody is billed for a ' +
      'Turn that answers a plausible sentence about their typo.'
    expect(read('/effort maximum'), why).toEqual({ kind: 'unknown', name: 'maximum' })
  })

  it('reads no argument as a request to report', () => {
    expect(read('/effort')).toEqual({ kind: 'report' })
  })

  it('ignores the whitespace and the casing a Channel or a keyboard added', () => {
    expect(read('  /effort MAX\n')).toEqual({ kind: 'chosen', level: 'max' })
    expect(read('/Effort')).toEqual({ kind: 'report' })
  })

  it('leaves a message that merely begins with /effort as work', () => {
    expect(read('/effort to make this faster')).toBeNull()
    expect(read('/efforts')).toBeNull()
    expect(read('how much effort is this on?')).toBeNull()
  })

  it('lists every name a Caller may type, the one for the Pinned Effort included', () => {
    expect(EFFORT_NAMES).toEqual([...EFFORT_MENU, 'default'])
  })
})

describe('which models take an effort', () => {
  it('says haiku takes none', () => {
    expect(takesEffort('claude-haiku-4-5')).toBe(false)
  })

  it('says the other three Menu models take one [fence:menu-fable-takes-effort]', () => {
    const why =
      'fable, opus and sonnet must read as taking an effort (ADR-0016). The extractor reports ' +
      'all three as unnamed on every gate, and fable most easily flips to false on a re-audit; ' +
      'flipped, roma tells every Caller on fable their /effort does not apply, and nothing ' +
      'else would catch it.'
    expect(takesEffort('claude-fable-5'), why).toBe(true)
    expect(takesEffort('claude-opus-5'), why).toBe(true)
    expect(takesEffort('claude-sonnet-5'), why).toBe(true)
  })

  it('says nothing at all about a model it has not been read about [fence:menu-effort-unread-model-says-nothing]', () => {
    const why =
      'takesEffort must answer null for a model the Matrix has not been read about, never ' +
      'true or false (ADR-0016). Yes asserts a fact roma has not established; no tells a ' +
      'Caller their setting is inert when it may well not be. That includes a name only ' +
      'Object.prototype carries.'
    expect(takesEffort('claude-mythos-5'), why).toBeNull()
    expect(takesEffort('claude-opus-5[1m]'), why).toBeNull()
    expect(takesEffort('constructor'), why).toBeNull()
  })

  it('covers every model a Caller may choose', () => {
    for (const model of Object.values(MENU)) expect(takesEffort(model)).not.toBeNull()
  })

  it('has a word for “did not apply” that is not a level', () => {
    expect(EFFORT_MENU).not.toContain(EFFORT_NOT_APPLIED)
  })
})

describe('what an operator may pin', () => {
  it('takes every level a Caller may choose', () => {
    for (const level of EFFORT_MENU) expect(isPinnableEffort(level)).toBe(true)
  })

  it('takes ultracode, which is the one thing the Menu holds back', () => {
    expect(isPinnableEffort(ULTRACODE)).toBe(true)
    expect(EFFORT_MENU).not.toContain(ULTRACODE)
  })

  it('does not take default, which would be pinning the pin', () => {
    expect(isPinnableEffort('default')).toBe(false)
  })

  it('does not take a level the build would silently ignore [fence:menu-effort-pin-refused-at-boot]', () => {
    const why =
      'isPinnableEffort must refuse at boot anything but the Menu and ultracode (ADR-0016). ' +
      'An unrecognised --effort does not fail the spawn: it warns on stderr and runs on the ' +
      "build's own default, so roma would be wrong about the effort of every Session it " +
      'serves and nothing would stop.'
    expect(isPinnableEffort('bananas'), why).toBe(false)
    expect(isPinnableEffort('auto'), why).toBe(false)
    expect(isPinnableEffort('HIGH'), why).toBe(false)
  })
})
