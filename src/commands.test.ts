import { describe, expect, it } from 'vitest'
import { CAVEMAN_NAMES, readCavemanRequest } from './caveman.js'
import { commandFor, readCommand } from './commands.js'
import { EFFORT_NAMES, readEffortRequest } from './effort-menu.js'
import { MENU_NAMES, readModelRequest } from './model-menu.js'

function commandIn(text: string): string | null {
  return readCommand(text)?.command ?? null
}

describe('reading a message as a Command', () => {
  it('recognises the seven Commands roma has', () => {
    expect(commandIn('/stop')).toBe('stop')
    expect(commandIn('/clear')).toBe('clear')
    expect(commandIn('/model')).toBe('model')
    expect(commandIn('/effort')).toBe('effort')
    expect(commandIn('/caveman')).toBe('caveman')
    expect(commandIn('/config')).toBe('config')
    expect(commandIn('/usage')).toBe('usage')
  })

  it('claims a spelling that is nobody’s build, and only the one', () => {
    expect(commandIn('/caveman')).toBe('caveman')
    expect(readCommand('/caveman ultra')).toEqual({ command: 'caveman', argument: 'ultra' })
  })

  it('leaves caveman’s five sibling commands unclaimed, which ADR-0030 records rather than fixes', () => {
    for (const sibling of ['stats', 'compress', 'commit', 'review', 'help']) {
      expect(readCommand(`/caveman-${sibling}`)).toBeNull()
    }
  })

  it('answers to every spelling of its reset', () => {
    expect(commandIn('/clear')).toBe('clear')
    expect(commandIn('/reset')).toBe('clear')
    expect(commandIn('/new')).toBe('clear')
  })

  it('recognises them however they were capitalised', () => {
    expect(commandIn('/Stop')).toBe('stop')
    expect(commandIn('/NEW')).toBe('clear')
    expect(commandIn('/Clear')).toBe('clear')
    expect(readCommand('/Model Opus')).toEqual({ command: 'model', argument: 'opus' })
  })

  it('ignores the whitespace a Channel wrapped them in', () => {
    expect(commandIn('  /stop\n')).toBe('stop')
    expect(readCommand('  /model opus  ')).toEqual({ command: 'model', argument: 'opus' })
  })

  it('answers to both of Claude Code’s spellings for its settings', () => {
    expect(commandIn('/config')).toBe('config')
    expect(commandIn('/settings')).toBe('config')
  })

  it('answers to all three of Claude Code’s spellings for its usage', () => {
    expect(commandIn('/usage')).toBe('usage')
    expect(commandIn('/cost')).toBe('usage')
    expect(commandIn('/stats')).toBe('usage')
  })

  describe('the Commands that take an argument', () => {
    it('carries the argument it was given', () => {
      expect(readCommand('/model opus')).toEqual({ command: 'model', argument: 'opus' })
    })

    it('is the same Command with nothing after it [fence:commands-bare-head-is-a-command]', () => {
      const why =
        'An argument-taking head must stay a Command on its own (ADR-0014, ADR-0017): its ' +
        'spelling is on the whole-message table as well as the argument table, and dropping it ' +
        'from the first stops `/model` alone being a Command, so it falls through as prose and ' +
        'somebody is billed for a Turn about it.'
      expect(readCommand('/model'), why).toEqual({ command: 'model', argument: null })
    })

    it('claims a name roma does not offer, so that it can be refused', () => {
      expect(readCommand('/model gpt-5')).toEqual({ command: 'model', argument: 'gpt-5' })
      expect(readCommand('/model claude-opus-5')).toEqual({
        command: 'model',
        argument: 'claude-opus-5',
      })
    })

    it('leaves a message that merely begins with it as work [fence:commands-one-argument-or-none]', () => {
      const why =
        'A head takes one argument or none (ADR-0003, ADR-0014): two words after it are a ' +
        'sentence meant for the agent, and reading them as a Command swallows the message and ' +
        'answers it with a refusal.'
      expect(readCommand('/model the deploy as a state machine'), why).toBeNull()
      expect(readCommand('/model opus please'), why).toBeNull()
      expect(readCommand('/models'), why).toBeNull()
    })

    it('carries the arguments the other three take', () => {
      expect(readCommand('/effort max')).toEqual({ command: 'effort', argument: 'max' })
      expect(readCommand('/caveman lite')).toEqual({ command: 'caveman', argument: 'lite' })
      expect(readCommand('/config theme=dark')).toEqual({
        command: 'config',
        argument: 'theme=dark',
      })
    })

    it('carries a hyphenated name as one argument', () => {
      expect(readCommand('/caveman wenyan-full')).toEqual({
        command: 'caveman',
        argument: 'wenyan-full',
      })
    })

    it('is the same Command with nothing after it [fence:commands-bare-head-is-a-command]', () => {
      const why =
        'An argument-taking head must stay a Command on its own (ADR-0016, ADR-0017, ADR-0030): ' +
        'dropping it from the whole-message table turns the bare head into billed prose.'
      expect(readCommand('/effort'), why).toEqual({ command: 'effort', argument: null })
      expect(readCommand('/caveman'), why).toEqual({ command: 'caveman', argument: null })
      expect(readCommand('/config'), why).toEqual({ command: 'config', argument: null })
    })

    it('claims a /config argument roma will refuse, rather than letting it fall through', () => {
      expect(readCommand('/config model=opusplan')).toEqual({
        command: 'config',
        argument: 'model=opusplan',
      })
    })

    it('grants the argument to no other Command', () => {
      expect(readCommand('/stop the deploy')).toBeNull()
      expect(readCommand('/clear foo')).toBeNull()
    })

    it('does not grant it to the usage Command, which is a gap ADR-0027 left open', () => {
      expect(readCommand('/usage july')).toBeNull()
      expect(readCommand('/cost ada')).toBeNull()
      expect(readCommand('/stats today')).toBeNull()
    })

    it('does not grant it to the alias, which is a gap ADR-0017 left open', () => {
      expect(readCommand('/settings theme=dark')).toBeNull()
    })
  })

  it('claims no slash command that is not its own [fence:commands-no-prefix-match]', () => {
    const why =
      'A Command is named exactly, never matched by prefix or by shape (ADR-0003): a rule that ' +
      '"begins with a slash and looks like ours" inherits every command a later Claude Code ' +
      'release adds and swallows it, where a named list fails closed.'
    expect(readCommand('/compact'), why).toBeNull()
    expect(readCommand('/compact keep the ADRs'), why).toBeNull()
    expect(readCommand('/newsletter'), why).toBeNull()
    expect(readCommand('/context'), why).toBeNull()
    expect(readCommand('/models opus'), why).toBeNull()
    expect(readCommand('/effortless max'), why).toBeNull()
    expect(readCommand('/stopwatch'), why).toBeNull()
  })

  it('leaves a reset with an argument to Claude Code', () => {
    expect(readCommand('/clear foo')).toBeNull()
    expect(readCommand('/new deploy branch')).toBeNull()
  })

  it('leaves a /config of two words to Claude Code [fence:commands-one-argument-or-none]', () => {
    const why =
      'A head takes one argument or none (ADR-0017): `/config foo bar` is left open as prose ' +
      'rather than swallowed.'
    expect(readCommand('/config foo bar'), why).toBeNull()
  })

  it('leaves ordinary work alone', () => {
    expect(readCommand('what does this repository do?')).toBeNull()
    expect(readCommand('')).toBeNull()
  })

  it('needs the slash', () => {
    expect(readCommand('stop')).toBeNull()
    expect(readCommand('new')).toBeNull()
    expect(readCommand('clear')).toBeNull()
    expect(readCommand('reset')).toBeNull()
    expect(readCommand('model opus')).toBeNull()
    expect(readCommand('effort max')).toBeNull()
    expect(readCommand('config')).toBeNull()
  })
})

describe('a Menu name a Caller may press instead of type', () => {
  it('round-trips through the Command reader, for every name on all three Menus [fence:commands-menu-names-round-trip]', () => {
    const why =
      'A Menu button is a message (ADR-0023), so commandFor must write what readCommand reads ' +
      'back as the same choice: a name that does not round-trip falls through as work and ' +
      'bills a Turn for a button press.'
    const menus = [
      { command: 'model' as const, names: MENU_NAMES },
      { command: 'effort' as const, names: EFFORT_NAMES },
      { command: 'caveman' as const, names: CAVEMAN_NAMES },
    ]

    for (const { command, names } of menus) {
      for (const name of names) {
        expect(readCommand(commandFor(command, name)), why).toEqual({ command, argument: name })
      }
    }
  })

  it('resolves back to the very choice the button claimed', () => {
    for (const name of MENU_NAMES) {
      const request = readModelRequest(readCommand(commandFor('model', name))?.argument ?? null)
      expect(request.kind).not.toBe('unknown')
      if (request.kind === 'chosen') expect(request.name).toBe(name)
    }
    for (const name of EFFORT_NAMES) {
      const request = readEffortRequest(readCommand(commandFor('effort', name))?.argument ?? null)
      expect(request.kind).not.toBe('unknown')
      if (request.kind === 'chosen') expect(request.level).toBe(name)
    }
    for (const name of CAVEMAN_NAMES) {
      const request = readCavemanRequest(readCommand(commandFor('caveman', name))?.argument ?? null)
      expect(request.kind).not.toBe('unknown')
      if (request.kind === 'chosen') expect(request.level).toBe(name)
    }
  })

  it('has all three Menus say what they hold, so none can empty unnoticed', () => {
    expect(MENU_NAMES).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'default'])
    expect(EFFORT_NAMES).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'default'])
    expect(CAVEMAN_NAMES).toEqual(['off', 'lite', 'full', 'ultra', 'wenyan-full', 'default'])
  })

  it('survives the hyphen the Caveman Menu was the first to carry', () => {
    expect(readCommand(commandFor('caveman', 'wenyan-full'))).toEqual({
      command: 'caveman',
      argument: 'wenyan-full',
    })
    expect(readCavemanRequest('wenyan-full')).toEqual({ kind: 'chosen', level: 'wenyan-full' })
  })

  it('carries no whitespace and no uppercase, on any of the three Menus', () => {
    for (const names of [MENU_NAMES, EFFORT_NAMES, CAVEMAN_NAMES]) {
      for (const name of names) {
        expect(name).not.toMatch(/\s/)
        expect(name).toBe(name.toLowerCase())
      }
    }
  })

  it('would fail on a name with whitespace or the wrong case', () => {
    expect(readCommand(commandFor('model', 'claude opus'))).toBeNull()
    expect(readModelRequest('Opus').kind).toBe('unknown')
    expect(readCommand(commandFor('caveman', 'wenyan full'))).toBeNull()
    expect(readCavemanRequest('Ultra').kind).toBe('unknown')
  })
})
