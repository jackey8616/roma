import { describe, expect, it } from 'vitest'
import { commandFor, readCommand } from './commands.js'
import { EFFORT_NAMES, readEffortRequest } from './effort-menu.js'
import { MENU_NAMES, readModelRequest } from './model-menu.js'

/** Which Command a message is, ignoring what followed it. */
function commandIn(text: string): string | null {
  return readCommand(text)?.command ?? null
}

describe('reading a message as a Command', () => {
  it('recognises the six Commands roma has', () => {
    expect(commandIn('/stop')).toBe('stop')
    expect(commandIn('/clear')).toBe('clear')
    expect(commandIn('/model')).toBe('model')
    expect(commandIn('/effort')).toBe('effort')
    expect(commandIn('/config')).toBe('config')
    expect(commandIn('/usage')).toBe('usage')
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

  // The same rule for a fault it was not written for. These three were free
  // Relays and answered by the real command, so leaving one behind would cost
  // nobody a Turn — it would leave a spelling answering about the process that
  // happens to be serving this Session next to one answering about the
  // deployment, which is ADR-0013's fault with the money swapped for a number
  // (ADR-0027). Three spellings, one Command; six is still the Commands.
  it('answers to all three of Claude Code’s spellings for its usage', () => {
    expect(commandIn('/usage')).toBe('usage')
    expect(commandIn('/cost')).toBe('usage')
    expect(commandIn('/stats')).toBe('usage')
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

    // On all three spellings, and the gap is the one `/clear foo` has had since
    // ADR-0013: roma's `/usage` has nothing to name — not a month, not a person,
    // not a Session — so each falls through and is billed as prose. Recorded by
    // ADR-0027 rather than closed, because closing it means deciding what a
    // shared thread may ask about other people.
    it('does not grant it to the usage Command, which is a gap ADR-0027 left open', () => {
      expect(readCommand('/usage july')).toBeNull()
      expect(readCommand('/cost ada')).toBeNull()
      expect(readCommand('/stats today')).toBeNull()
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

/**
 * Every name roma will put on a button has to survive being written out as a
 * message and read back (ADR-0023).
 *
 * A structural invariant rather than a behaviour test, in the idiom of the
 * Command/Relay overlap check in `relays.test.ts`, the ADR numbering check and
 * the containment checks — a claim about this repository, belonging to none of
 * the three seams.
 *
 * It exists because a button is a *message* here, so a Menu name that does not
 * round-trip does not fail loudly: it produces a message `readCommand` reads as
 * prose, which falls through to Claude Code and bills somebody for a Turn. That
 * is the exact fault ADR-0014 built the `/model` Command to remove, arriving
 * through the door ADR-0023 opened.
 *
 * Driven over the real Menus, never a copy. `relays.test.ts` records what a copy
 * costs: the hardcoded one it replaced held four of eight spellings and went on
 * passing while covering half the table. So this also needs that check's second
 * half — both Menus named outright, so an emptied Menu fails rather than passing
 * vacuously.
 *
 * Both Menus need this and neither is stable: each declares itself a person's
 * judgement about one pinned Claude Code build, to be re-audited when the pin
 * moves. This is the mechanism `effort-menu.ts` says "somebody remembers"
 * stopped being.
 */
describe('a Menu name a Caller may press instead of type', () => {
  it('round-trips through the Command reader, for every name on both Menus', () => {
    const menus = [
      { command: 'model' as const, names: MENU_NAMES },
      { command: 'effort' as const, names: EFFORT_NAMES },
    ]

    for (const { command, names } of menus) {
      for (const name of names) {
        expect(readCommand(commandFor(command, name))).toEqual({ command, argument: name })
      }
    }
  })

  // One step further than the reader: a name that parses as an argument and then
  // lands in `unknown` would refuse a Caller a model roma had just offered them,
  // which reads as roma arguing with itself.
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
  })

  // The checks above pass vacuously against an empty Menu, and a re-audit that
  // dropped a name is exactly how that happens. Named here so losing one is a
  // failure rather than a silently shorter card.
  it('has both Menus say what they hold, so neither can empty unnoticed', () => {
    expect(MENU_NAMES).toEqual(['opus', 'sonnet', 'haiku', 'default'])
    expect(EFFORT_NAMES).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'default'])
  })

  // The two shapes that would break the round trip, spelled out so somebody
  // adding a name knows what the checks above are watching for. Neither looks
  // hypothetical once you know a button is a message: a level with a space in it
  // and a display name that kept its capital are both plausible additions.
  it('would fail on a name with whitespace or the wrong case', () => {
    expect(readCommand(commandFor('model', 'claude opus'))).toBeNull()
    expect(readModelRequest('Opus').kind).toBe('unknown')
  })
})
