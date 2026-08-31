import { describe, expect, it } from 'vitest'
import { readCommand } from './commands.js'
import { MENU, MENU_NAMES, menuNameFor, readModelRequest, type ModelRequest } from './model-menu.js'

/**
 * What a message asks roma to do about the model, or null if it is not asking.
 *
 * The two halves as the Core uses them: `readCommand` decides which messages are
 * `/model` at all, and `readModelRequest` decides what the argument means. Driven
 * together here because a Caller types one message, and the questions this file
 * asks — the casing, the whitespace, an argument that is really a sentence — fall
 * on one side or the other and nobody typing them knows which.
 */
function read(text: string): ModelRequest | null {
  const command = readCommand(text)
  return command?.command === 'model' ? readModelRequest(command.argument) : null
}

describe('reading a /model message', () => {
  it('recognises every name on the Menu', () => {
    expect(read('/model fable')).toEqual({ kind: 'chosen', name: 'fable', model: 'claude-fable-5' })
    expect(read('/model opus')).toEqual({ kind: 'chosen', name: 'opus', model: 'claude-opus-5' })
    expect(read('/model sonnet')).toEqual({
      kind: 'chosen',
      name: 'sonnet',
      model: 'claude-sonnet-5',
    })
    expect(read('/model haiku')).toEqual({
      kind: 'chosen',
      name: 'haiku',
      model: 'claude-haiku-4-5',
    })
  })

  // `default` names the Pinned Model rather than a model of its own, which is
  // why nothing here resolves it: a deployment that moved `ROMA_MODEL` would
  // otherwise strand every Session that asked for "default" on the model roma
  // used to run.
  it('reads default as a name of its own rather than as a model', () => {
    expect(read('/model default')).toEqual({ kind: 'default' })
  })

  // Refused rather than passed on as work, and by name so it can be corrected in
  // the next message. Falling through is the fault this whole feature exists to
  // fix: the Caller Marker goes above the message, so Claude Code never sees a
  // command and somebody is billed for a sentence about their typo.
  it('refuses a name roma does not offer, and says which', () => {
    expect(read('/model gpt-5')).toEqual({ kind: 'unknown', name: 'gpt-5' })
  })

  // The Menu is an offer rather than a filter: Claude Code takes "a full model
  // ID" and the `[1m]` variants, so no list roma held could ever be a complete
  // check. What it decides is what roma is willing to put the shared window
  // behind.
  it('offers neither a full model id nor the 1M variants', () => {
    expect(read('/model claude-opus-5')).toEqual({ kind: 'unknown', name: 'claude-opus-5' })
    expect(read('/model opus[1m]')).toEqual({ kind: 'unknown', name: 'opus[1m]' })
    expect(read('/model sonnet[1m]')).toEqual({ kind: 'unknown', name: 'sonnet[1m]' })
    // Named alongside them now that `fable` itself is on the Menu, which is what
    // makes this the `[1m]` a Caller is most likely to reach for. The reason it
    // is refused is the one above `MENU` and is unchanged: more context per Turn
    // is still more of a window everybody shares.
    expect(read('/model fable[1m]')).toEqual({ kind: 'unknown', name: 'fable[1m]' })
  })

  // Claude Code's own no-argument `/model` is an interactive picker, which a
  // Channel cannot render. Reporting is what the gesture can honestly mean in a
  // text channel, and roma can answer it because it owns the answer.
  it('reads no argument as a request to report', () => {
    expect(read('/model')).toEqual({ kind: 'report' })
  })

  it('ignores the whitespace a Channel wrapped it in', () => {
    expect(read('  /model opus\n')).toEqual({
      kind: 'chosen',
      name: 'opus',
      model: 'claude-opus-5',
    })
    expect(read('  /model  ')).toEqual({ kind: 'report' })
  })

  // A phone keyboard capitalises the first letter of a message on its own, and
  // `/Model Opus` is nobody asking for something else.
  it('ignores case, in the head and in the name', () => {
    expect(read('/Model Opus')).toEqual({ kind: 'chosen', name: 'opus', model: 'claude-opus-5' })
    expect(read('/MODEL')).toEqual({ kind: 'report' })
  })

  // One argument is an argument; several words are a sentence. This is what
  // keeps something meant for the agent from being swallowed by a Command that
  // would answer it with a refusal.
  it('leaves a message that merely begins with /model as work', () => {
    expect(read('/model the deploy as a state machine')).toBeNull()
    expect(read('/model opus please')).toBeNull()
    expect(read('/models')).toBeNull()
    expect(read('what model is this on?')).toBeNull()
  })

  // The list a refusal quotes and a report offers. Held here rather than
  // rebuilt at each of them, so the two can never name different Menus.
  it('lists every name a Caller may type, the one for the Pinned Model included', () => {
    expect(MENU_NAMES).toEqual([...Object.keys(MENU), 'default'])
  })

  // Order is load-bearing rather than cosmetic: `MENU_NAMES` derives from it and
  // both Adapters draw their buttons in it, so the Menu is read left to right as
  // what a Caller is reaching for. Descending cost, most expensive first.
  it('lists them in the order it means them to be read', () => {
    expect(MENU_NAMES).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'default'])
  })
})

/**
 * The Menu read backwards, which is how roma says what a Session is already on.
 *
 * roma keeps the resolved id, so a report naming only that would offer a list of
 * names against a model spelled another way — and leave the Caller to find out
 * by being refused that the id itself is not something they may type.
 */
describe('naming the model a Session is on', () => {
  it('answers with the name a Caller would have typed', () => {
    expect(menuNameFor('claude-fable-5')).toBe('fable')
    expect(menuNameFor('claude-opus-5')).toBe('opus')
    expect(menuNameFor('claude-sonnet-5')).toBe('sonnet')
    expect(menuNameFor('claude-haiku-4-5')).toBe('haiku')
  })

  // Null rather than the id, because there is no name for it: a deployment that
  // pinned `ROMA_MODEL` to something off the Menu has one, and it is reported as
  // the bare id because that is the truthful answer.
  it('says nothing for a model no name on the Menu resolves to', () => {
    expect(menuNameFor('claude-fable-5-mythos-5')).toBeNull()
    expect(menuNameFor('claude-opus-5[1m]')).toBeNull()
  })
})
