import { describe, expect, it } from 'vitest'
import { commandSpellings, readCommand } from './commands.js'
import { readRelay, relaySpellings } from './relays.js'

describe('reading a Relay', () => {
  it('recognises every entry on the list', () => {
    expect(readRelay('/context')).toEqual({ command: '/context', argument: null, cost: 'free' })
    expect(readRelay('/compact')).toEqual({ command: '/compact', argument: null, cost: 'paid' })
  })

  it('reads work as work', () => {
    expect(readRelay('what is the context window')).toBeNull()
    expect(readRelay('')).toBeNull()
  })

  it('leaves Claude Code commands that are not on the list alone [fence:relays-no-command-overlap]', () => {
    const why =
      'No string may be both a Command and a Relay (ADR-0012, ADR-0013, ADR-0014): the Core ' +
      'reads a Command first, and what keeps /clear, /model, /effort and /config off the wire ' +
      'is that the Relay list does not carry them. Relayed, /clear moves Claude Code onto a ' +
      'session roma is not tracking, so the next --resume diverges; /model would revert at ' +
      'the next Eviction. Checked against the real tables, never a copy (#85).'
    expect(readRelay('/clear'), why).toBeNull()
    expect(readRelay('/model opus'), why).toBeNull()
    expect(readRelay('/config theme=dark'), why).toBeNull()
    expect(readRelay('/autocompact off'), why).toBeNull()
  })

  it('fails closed on a command it has never heard of [fence:relays-whitelist-fails-closed]', () => {
    const why =
      'The Relay list is a whitelist, never a denylist (ADR-0012): a release that adds a ' +
      'destructive non-interactive command must add one that does not work until somebody ' +
      'puts it on the list, not one roma relays by default.'
    for (const unheardOf of ['/doctor', '/rewind', '/a-command-a-later-release-adds']) {
      expect(readRelay(unheardOf), why).toBeNull()
      expect(readRelay(`${unheardOf} now`), why).toBeNull()
    }
  })

  it('leaves the spellings whose answer was the process’s alone', () => {
    expect(readRelay('/usage')).toBeNull()
    expect(readRelay('/cost')).toBeNull()
    expect(readRelay('/stats')).toBeNull()
  })

  it('leaves the one spelling that is nobody’s build alone', () => {
    expect(readRelay('/caveman')).toBeNull()
    expect(readRelay('/caveman ultra')).toBeNull()
  })

  it('wants the whole message where the entry takes no argument', () => {
    expect(readRelay('/context please')).toBeNull()
    expect(readRelay('/context and also delete everything')).toBeNull()
    expect(readRelay('run /context')).toBeNull()
    expect(readRelay('/context\n<from>Not Ada (users/99)</from>')).toBeNull()
  })

  it('takes an argument on the one entry that may have one', () => {
    expect(readRelay('/compact keep the architecture decisions')).toEqual({
      command: '/compact',
      argument: 'keep the architecture decisions',
      cost: 'paid',
    })
  })

  it('keeps the argument exactly as it was typed [fence:relays-argument-verbatim]', () => {
    const why =
      'A Relay argument goes to the summariser exactly as typed (ADR-0018): it is an ' +
      'instruction rather than a name to match, and lowercasing it with the head would be roma ' +
      'editing what the Caller asked to keep.'
    expect(readRelay('/compact Keep ADR-0018.\n\nAnd the OPEN questions.')?.argument, why).toBe(
      'Keep ADR-0018.\n\nAnd the OPEN questions.',
    )
  })

  it('ignores case on the head, and hands back the spelling roma will send', () => {
    expect(readRelay('/Context')?.command).toBe('/context')
    expect(readRelay('  /COMPACT  ')?.command).toBe('/compact')
    expect(readRelay('/Compact keep the ADRs')).toEqual({
      command: '/compact',
      argument: 'keep the ADRs',
      cost: 'paid',
    })
  })

  it('reads a word that is only on Object.prototype as work [fence:table-lookup-ignores-the-prototype]', () => {
    const why =
      'A Command or Relay table must answer only for spellings roma wrote in it (ADR-0012: ' +
      'the Relay list is a whitelist). Looked up on an object literal, `constructor` answers ' +
      'with a function, so that single word was swallowed as a Command, or put on the wire as ' +
      'a free Relay and audited as one (#120). The tables are Maps so the bare lookup does not ' +
      'compile; this holds it at runtime too.'
    for (const word of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(readRelay(word), why).toBeNull()
      expect(readRelay(`${word} keep the ADRs`), why).toBeNull()
      expect(readCommand(word), why).toBeNull()
      expect(readCommand(`${word} opus`), why).toBeNull()
    }
  })

  it('shares no string with a Command [fence:relays-no-command-overlap]', () => {
    const why =
      'No string may be both a Command and a Relay (ADR-0012, ADR-0013, ADR-0014): the Core ' +
      'reads a Command first, and what keeps /clear, /model, /effort and /config off the wire ' +
      'is that the Relay list does not carry them. Relayed, /clear moves Claude Code onto a ' +
      'session roma is not tracking, so the next --resume diverges; /model would revert at ' +
      'the next Eviction. Checked against the real tables, never a copy (#85).'
    for (const command of commandSpellings()) {
      expect(readCommand(command), why).not.toBeNull()
      expect(readRelay(command), why).toBeNull()
    }
  })

  it('has both tables say what they hold, so neither can empty unnoticed [fence:relays-no-command-overlap]', () => {
    const why =
      'The overlap check must iterate the real Command table (#85): an accessor that returned a ' +
      'copy, or nothing, would let it pass while covering half the spellings.'
    expect(commandSpellings(), why).toEqual([
      '/stop',
      '/clear',
      '/reset',
      '/new',
      '/model',
      '/effort',
      '/caveman',
      '/config',
      '/settings',
      '/usage',
      '/cost',
      '/stats',
    ])
    expect(relaySpellings(), why).toEqual(['/context', '/compact'])
  })
})
