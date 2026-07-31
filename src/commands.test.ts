import { describe, expect, it } from 'vitest'
import { readCommand } from './commands.js'

/** Which Command a message is, ignoring what followed it. */
function commandIn(text: string): string | null {
  return readCommand(text)?.command ?? null
}

describe('reading a message as a Command', () => {
  it('recognises the three Commands roma has', () => {
    expect(commandIn('/stop')).toBe('stop')
    expect(commandIn('/clear')).toBe('clear')
    expect(commandIn('/model')).toBe('model')
  })

  // ADR-0013. `clear` is Claude Code's name for this and `new` is one of its two
  // aliases, so roma answered to the spelling a person is least likely to reach
  // for and billed them for a plausible sentence about the other two. Three
  // spellings, one Command — the count that is three is the Commands, not the
  // strings.
  it('answers to every spelling of its reset', () => {
    expect(commandIn('/clear')).toBe('clear')
    expect(commandIn('/reset')).toBe('clear')
    expect(commandIn('/new')).toBe('clear')
  })

  // A phone keyboard capitalises the first letter of a message on its own, and
  // nobody typing "/Stop" meant anything else.
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

  // ADR-0014's one new rule: a listed head may take an argument, and the list
  // holds `/model` and nothing else. What that keeps out is the prefix match
  // ADR-0003 refused — a general "begins with a slash and looks like ours" rule
  // inherits every command a later Claude Code release adds, and a named list
  // does not grow on its own.
  describe('the one Command that takes an argument', () => {
    it('carries the argument it was given', () => {
      expect(readCommand('/model opus')).toEqual({ command: 'model', argument: 'opus' })
    })

    // Not a malformed `/model` — it is the Command asking roma to report, which
    // is what that gesture can honestly mean in a text channel.
    it('is the same Command with nothing after it', () => {
      expect(readCommand('/model')).toEqual({ command: 'model', argument: null })
    })

    // An argument roma does not offer is still a Command, and is refused as one
    // rather than passed on. Falling through is the exact fault this exists to
    // fix: the Caller Marker goes above the message, so Claude Code never sees a
    // command, and somebody is billed for a sentence about their typo.
    it('claims a name roma does not offer, so that it can be refused', () => {
      expect(readCommand('/model gpt-5')).toEqual({ command: 'model', argument: 'gpt-5' })
      expect(readCommand('/model claude-opus-5')).toEqual({
        command: 'model',
        argument: 'claude-opus-5',
      })
    })

    // One argument is an argument; three words are a sentence. This is what
    // keeps a message somebody meant for the agent from being swallowed by a
    // Command that would answer it with a refusal.
    it('leaves a message that merely begins with it as work', () => {
      expect(readCommand('/model the deploy as a state machine')).toBeNull()
      expect(readCommand('/model opus please')).toBeNull()
      expect(readCommand('/models')).toBeNull()
    })

    it('grants the argument to no other Command', () => {
      expect(readCommand('/stop the deploy')).toBeNull()
      expect(readCommand('/clear foo')).toBeNull()
    })
  })

  // Every slash command that is not roma's is somebody else's — Claude Code's to
  // answer as a Readout if it is on ADR-0012's list, and work if it is not.
  it('claims no slash command that is not its own', () => {
    expect(readCommand('/compact')).toBeNull()
    expect(readCommand('/newsletter')).toBeNull()
    // A Readout, which `readReadout` answers — and only because nothing here
    // did. Asserted from this side too, since a Command shadows one silently.
    expect(readCommand('/context')).toBeNull()
  })

  // Claude Code's `/clear` takes a name and roma's reset takes nothing, so the
  // whole-message rule turns this away and it is billed as prose. Left open
  // deliberately (ADR-0013): closing it means deciding what a name would mean to
  // roma. ADR-0014 narrowed the rule rather than dropping it, so this is still
  // true after `/model` gained an argument.
  it('leaves a reset with an argument to Claude Code', () => {
    expect(readCommand('/clear foo')).toBeNull()
    expect(readCommand('/new deploy branch')).toBeNull()
  })

  it('leaves ordinary work alone', () => {
    expect(readCommand('what does this repository do?')).toBeNull()
    expect(readCommand('')).toBeNull()
  })

  // The words on their own are things people say to an agent — "stop" mid-Task
  // is a sentence Claude Code can act on, and roma swallowing it would answer
  // something nobody asked.
  it('needs the slash', () => {
    expect(readCommand('stop')).toBeNull()
    expect(readCommand('new')).toBeNull()
    expect(readCommand('clear')).toBeNull()
    expect(readCommand('reset')).toBeNull()
    expect(readCommand('model opus')).toBeNull()
  })
})
