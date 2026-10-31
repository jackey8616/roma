import { describe, expect, it } from 'vitest'
import { readCommand } from './commands.js'
import { MENU, MENU_NAMES, menuNameFor, readModelRequest, type ModelRequest } from './model-menu.js'

function read(text: string): ModelRequest | null {
  const command = readCommand(text)
  return command?.command === 'model' ? readModelRequest(command.argument) : null
}

const UNKNOWN_IS_REFUSED =
  'A /model argument that is not a name on the Menu must be read as unknown and refused, ' +
  'never passed on as work (ADR-0014). The Caller Marker goes above the message, so Claude ' +
  'Code never sees a command and somebody is billed for a Turn that answers a plausible ' +
  'sentence about their typo.'

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

  it('reads default as a name of its own rather than as a model', () => {
    expect(read('/model default')).toEqual({ kind: 'default' })
  })

  it('refuses a name roma does not offer, and says which [fence:menu-model-unknown-is-refused]', () => {
    expect(read('/model gpt-5'), UNKNOWN_IS_REFUSED).toEqual({ kind: 'unknown', name: 'gpt-5' })
  })

  it('refuses a name only Object.prototype carries [fence:menu-model-unknown-is-refused]', () => {
    for (const name of ['constructor', 'tostring', 'hasownproperty']) {
      expect(read(`/model ${name}`), UNKNOWN_IS_REFUSED).toEqual({ kind: 'unknown', name })
    }
  })

  it('offers neither a full model id nor the 1M variants', () => {
    expect(read('/model claude-opus-5')).toEqual({ kind: 'unknown', name: 'claude-opus-5' })
    expect(read('/model opus[1m]')).toEqual({ kind: 'unknown', name: 'opus[1m]' })
    expect(read('/model sonnet[1m]')).toEqual({ kind: 'unknown', name: 'sonnet[1m]' })
    expect(read('/model fable[1m]')).toEqual({ kind: 'unknown', name: 'fable[1m]' })
  })

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

  it('ignores case, in the head and in the name', () => {
    expect(read('/Model Opus')).toEqual({ kind: 'chosen', name: 'opus', model: 'claude-opus-5' })
    expect(read('/MODEL')).toEqual({ kind: 'report' })
  })

  it('leaves a message that merely begins with /model as work', () => {
    expect(read('/model the deploy as a state machine')).toBeNull()
    expect(read('/model opus please')).toBeNull()
    expect(read('/models')).toBeNull()
    expect(read('what model is this on?')).toBeNull()
  })

  it('lists every name a Caller may type, the one for the Pinned Model included', () => {
    expect(MENU_NAMES).toEqual([...Object.keys(MENU), 'default'])
  })

  it('lists them most expensive first, the order every Channel draws [fence:menu-model-ordered-by-cost]', () => {
    const why =
      'The Model Menu is ordered by descending cost (ADR-0014). Both Adapters draw their ' +
      'buttons in `MENU` order, and the Menu is the spending boundary, so reading it ' +
      'downwards is how a Caller sees what they are reaching for before they reach.'
    expect(MENU_NAMES, why).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'default'])
  })
})

describe('naming the model a Session is on', () => {
  it('answers with the name a Caller would have typed', () => {
    expect(menuNameFor('claude-fable-5')).toBe('fable')
    expect(menuNameFor('claude-opus-5')).toBe('opus')
    expect(menuNameFor('claude-sonnet-5')).toBe('sonnet')
    expect(menuNameFor('claude-haiku-4-5')).toBe('haiku')
  })

  it('says nothing for a model no name on the Menu resolves to', () => {
    expect(menuNameFor('claude-mythos-5')).toBeNull()
    expect(menuNameFor('claude-opus-5[1m]')).toBeNull()
  })
})
