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

/**
 * What a message asks roma to do about the effort, or null if it is not asking.
 *
 * `model-menu.test.ts`'s helper, for its reason: `readCommand` decides which
 * messages are `/effort` at all and `readEffortRequest` decides what the
 * argument means, and nobody typing one knows which side of that their message
 * falls on.
 */
function read(text: string): EffortRequest | null {
  const command = readCommand(text)
  return command?.command === 'effort' ? readEffortRequest(command.argument) : null
}

describe('reading an /effort message', () => {
  // Every level the build has, which is what makes this unlike the Model Menu.
  // The Model Menu withholds models because a costlier model is a bigger share
  // of a shared window; neither the enumerability nor the cost argument survives
  // here, so a Caller asking to think harder about a task they are waiting on is
  // the feature.
  it('recognises every level on the Menu', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(read(`/effort ${level}`)).toEqual({ kind: 'chosen', level })
    }
  })

  // `default` names the Pinned Effort rather than a level of its own, which is
  // why nothing here resolves it: a deployment that moved `ROMA_EFFORT` would
  // otherwise strand every Session that asked for "default" at the old one.
  it('reads default as a name of its own rather than as a level', () => {
    expect(read('/effort default')).toEqual({ kind: 'default' })
  })

  // Off the Menu and reachable only through `ROMA_EFFORT`. It is not a sixth
  // level — the build's own table is `{ultracode:"xhigh"}` — it is `xhigh` plus
  // dynamic workflow orchestration, which turns one Task into a fleet on a
  // window everybody shares.
  it('refuses ultracode from a Caller, as it refuses any other name', () => {
    expect(read(`/effort ${ULTRACODE}`)).toEqual({ kind: 'unknown', name: ULTRACODE })
  })

  // `--effort auto` is rejected by the CLI's own parser, so the only way roma
  // could offer it is by omitting `--effort` — which reopens the shared settings
  // file that passing it on every spawn closes.
  it('does not offer auto, which cannot be pinned', () => {
    expect(read('/effort auto')).toEqual({ kind: 'unknown', name: 'auto' })
  })

  // The build has one alias, `med`. roma does not, and that is deliberate:
  // nothing here is relayed or compared against Claude Code, so an alias would
  // be a spelling roma had chosen to claim rather than one it inherited.
  it('does not inherit the build’s own alias for medium', () => {
    expect(read('/effort med')).toEqual({ kind: 'unknown', name: 'med' })
  })

  it('refuses a level roma does not offer, and says which', () => {
    expect(read('/effort maximum')).toEqual({ kind: 'unknown', name: 'maximum' })
  })

  it('reads no argument as a request to report', () => {
    expect(read('/effort')).toEqual({ kind: 'report' })
  })

  it('ignores the whitespace and the casing a Channel or a keyboard added', () => {
    expect(read('  /effort MAX\n')).toEqual({ kind: 'chosen', level: 'max' })
    expect(read('/Effort')).toEqual({ kind: 'report' })
  })

  // One argument is an argument; several words are a sentence. This is what
  // keeps something meant for the agent from being swallowed by a Command that
  // would answer it with a refusal.
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
  // The one row the pinned build refuses by name. Asserted as a literal rather
  // than read out of the Matrix, so a Matrix edited by accident fails here.
  it('says haiku takes none', () => {
    expect(takesEffort('claude-haiku-4-5')).toBe(false)
  })

  it('says the other two Menu models take one', () => {
    expect(takesEffort('claude-opus-5')).toBe(true)
    expect(takesEffort('claude-sonnet-5')).toBe(true)
  })

  // Three answers rather than two, and this is the third. A deployment that
  // pinned a model off the Model Menu has one the Matrix has never been read
  // about — and roma says nothing about it rather than asserting either way,
  // because both defaults would be roma stating a fact it has not established.
  it('says nothing at all about a model it has not been read about', () => {
    expect(takesEffort('claude-mythos-5')).toBeNull()
    expect(takesEffort('claude-opus-5[1m]')).toBeNull()
  })

  // The Matrix covers the Menu and nothing else: it exists to say what a Session
  // roma serves runs at, and a model no Caller can reach is not one roma has
  // anything to record about.
  it('covers every model a Caller may choose', () => {
    for (const model of Object.values(MENU)) expect(takesEffort(model)).not.toBeNull()
  })

  // Deliberately not spelled like a level, so a ledger read months later cannot
  // mistake it for one.
  it('has a word for “did not apply” that is not a level', () => {
    expect(EFFORT_MENU).not.toContain(EFFORT_NOT_APPLIED)
  })
})

describe('what an operator may pin', () => {
  it('takes every level a Caller may choose', () => {
    for (const level of EFFORT_MENU) expect(isPinnableEffort(level)).toBe(true)
  })

  // The Menu bounds Callers and never the operator, exactly as `ROMA_MODEL` may
  // already name a model off the Model Menu.
  it('takes ultracode, which is the one thing the Menu holds back', () => {
    expect(isPinnableEffort(ULTRACODE)).toBe(true)
    expect(EFFORT_MENU).not.toContain(ULTRACODE)
  })

  // `default` names the Pinned Effort, so a deployment pinning it would be
  // naming itself.
  it('does not take default, which would be pinning the pin', () => {
    expect(isPinnableEffort('default')).toBe(false)
  })

  // The measurement this whole check exists for: an unrecognised `--effort`
  // warns on stderr and starts on the build's own default, so nothing
  // downstream would ever refuse this.
  it('does not take a level the build would silently ignore', () => {
    expect(isPinnableEffort('bananas')).toBe(false)
    expect(isPinnableEffort('auto')).toBe(false)
    expect(isPinnableEffort('HIGH')).toBe(false)
  })
})
