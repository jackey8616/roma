import { describe, expect, it } from 'vitest'
import { readCommand } from './commands.js'

describe('reading a message as a Command', () => {
  it('recognises the two Commands roma has', () => {
    expect(readCommand('/stop')).toBe('stop')
    expect(readCommand('/clear')).toBe('clear')
  })

  // ADR-0013. `clear` is Claude Code's name for this and `new` is one of its two
  // aliases, so roma answered to the spelling a person is least likely to reach
  // for and billed them for a plausible sentence about the other two. Three
  // spellings, one Command — the count that is two is the Commands, not the
  // strings.
  it('answers to every spelling of its reset', () => {
    expect(readCommand('/clear')).toBe('clear')
    expect(readCommand('/reset')).toBe('clear')
    expect(readCommand('/new')).toBe('clear')
  })

  // A phone keyboard capitalises the first letter of a message on its own, and
  // nobody typing "/Stop" meant anything else.
  it('recognises them however they were capitalised', () => {
    expect(readCommand('/Stop')).toBe('stop')
    expect(readCommand('/NEW')).toBe('clear')
    expect(readCommand('/Clear')).toBe('clear')
  })

  it('ignores the whitespace a Channel wrapped them in', () => {
    expect(readCommand('  /stop\n')).toBe('stop')
  })

  // Every slash command that is not roma's is somebody else's — Claude Code's to
  // answer as a Readout if it is on ADR-0012's list, and work if it is not. A
  // message that merely starts with one of roma's is work too: neither of them
  // takes an argument, so "/stop the deploy" is someone asking Claude Code to
  // stop a deploy.
  it('claims no slash command that is not its own', () => {
    expect(readCommand('/model claude-sonnet-5')).toBeNull()
    expect(readCommand('/stop the deploy')).toBeNull()
    expect(readCommand('/newsletter')).toBeNull()
    // A Readout, which `readReadout` answers — and only because nothing here
    // did. Asserted from this side too, since a Command shadows one silently.
    expect(readCommand('/context')).toBeNull()
  })

  // Claude Code's `/clear` takes a name and roma's reset takes nothing, so the
  // whole-message rule turns this away and it is billed as prose. Left open
  // deliberately (ADR-0013): closing it means deciding what a name would mean to
  // roma, and roma has nothing to name.
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
  })
})
