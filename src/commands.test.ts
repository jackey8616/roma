import { describe, expect, it } from 'vitest'
import { readCommand } from './commands.js'

describe('reading a message as a Command', () => {
  it('recognises the two Commands roma has', () => {
    expect(readCommand('/stop')).toBe('stop')
    expect(readCommand('/new')).toBe('new')
  })

  // A phone keyboard capitalises the first letter of a message on its own, and
  // nobody typing "/Stop" meant anything else.
  it('recognises them however they were capitalised', () => {
    expect(readCommand('/Stop')).toBe('stop')
    expect(readCommand('/NEW')).toBe('new')
  })

  it('ignores the whitespace a Channel wrapped them in', () => {
    expect(readCommand('  /stop\n')).toBe('stop')
  })

  // Claude Code has slash commands of its own and roma passes every one of them
  // through untouched. A message that merely starts with one of roma's two is
  // work, not a Command: there is no roma Command that takes an argument, so
  // "/stop the deploy" is someone asking Claude Code to stop a deploy.
  it('leaves every other slash command to Claude Code', () => {
    expect(readCommand('/clear')).toBeNull()
    expect(readCommand('/model claude-sonnet-5')).toBeNull()
    expect(readCommand('/stop the deploy')).toBeNull()
    expect(readCommand('/newsletter')).toBeNull()
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
  })
})
