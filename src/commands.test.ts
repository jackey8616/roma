import { describe, expect, it } from 'vitest'
import { readCommand } from './commands.js'

/** Which Command a message is, ignoring what followed it. */
function commandIn(text: string): string | null {
  return readCommand(text)?.command ?? null
}

describe('reading a message as a Command', () => {
  it('recognises the five Commands roma has', () => {
    expect(commandIn('/stop')).toBe('stop')
    expect(commandIn('/clear')).toBe('clear')
    expect(commandIn('/model')).toBe('model')
    expect(commandIn('/effort')).toBe('effort')
    expect(commandIn('/config')).toBe('config')
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

  // `/config` answers to `/settings` for `/clear`'s reason, and it is
  // Claude Code's own declared alias on its own `/config`: a spelling roma
  // leaves unclaimed is one somebody is billed for (ADR-0017). Two spellings,
  // one Command — the count that is five is the Commands, not the strings.
  it('answers to both of Claude Code’s spellings for its settings', () => {
    expect(commandIn('/config')).toBe('config')
    expect(commandIn('/settings')).toBe('config')
  })

  // ADR-0014's rule, now carrying three heads: a listed head may take an
  // argument and nothing else may. What that keeps out is the prefix match
  // ADR-0003 refused — a general "begins with a slash and looks like ours" rule
  // inherits every command a later Claude Code release adds. The list still does
  // not grow on its own; it has grown by hand, three times, deliberately.
  describe('the Commands that take an argument', () => {
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

    it('carries the arguments the other two take', () => {
      expect(readCommand('/effort max')).toEqual({ command: 'effort', argument: 'max' })
      expect(readCommand('/config theme=dark')).toEqual({
        command: 'config',
        argument: 'theme=dark',
      })
    })

    // Each is the Command asking roma to report rather than a malformed one:
    // Claude Code's no-argument `/config` is a settings panel and a panel has no
    // form in a chat message, so reporting is what that gesture can honestly
    // mean in one (ADR-0017).
    it('is the same Command with nothing after it', () => {
      expect(readCommand('/effort')).toEqual({ command: 'effort', argument: null })
      expect(readCommand('/config')).toEqual({ command: 'config', argument: null })
    })

    // Claimed so that it can be *refused*: `/config key=value` writes a settings
    // file every Session in the deployment shares, so falling through is both
    // the bill nobody wanted and a change nobody made.
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

    // `/settings` is on the whole-message list and deliberately not on this one,
    // so `/settings key=value` falls through to a Task and is billed as prose.
    // The same opening `/clear foo` has had since ADR-0013, and ADR-0017 counted
    // the heads here at three knowing it.
    it('does not grant it to the alias, which is a gap ADR-0017 left open', () => {
      expect(readCommand('/settings theme=dark')).toBeNull()
    })
  })

  // Every slash command that is not roma's is somebody else's — Claude Code's to
  // answer as a Relay if it is on the ADR-0012 list, and work if it is not.
  it('claims no slash command that is not its own', () => {
    // `/compact` is a Relay since ADR-0018 and `/newsletter` is nobody's; both
    // have to fall through here, and for the same reason.
    expect(readCommand('/compact')).toBeNull()
    expect(readCommand('/compact keep the ADRs')).toBeNull()
    expect(readCommand('/newsletter')).toBeNull()
    // A Relay, which `readRelay` answers — and only because nothing here did.
    // Asserted from this side too, since a Command shadows one silently.
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

  // The same opening on `/config`, recorded rather than fixed: closing it means
  // deciding what a multi-word argument would mean to roma, and it would mean
  // nothing (ADR-0017).
  it('leaves a /config of two words to Claude Code', () => {
    expect(readCommand('/config foo bar')).toBeNull()
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
    expect(readCommand('effort max')).toBeNull()
    expect(readCommand('config')).toBeNull()
  })
})
