import type { OutboundInstruction, TaskProgress } from '../../channel-adapter.js'
import type { Command } from '../../commands.js'
import { progressPhrase } from '../../progress-phrase.js'

export const MAX_TEXT = 2000

export const OVERFLOW_BUTTON = 'Run it on metered billing'

const MAX_THREAD_NAME = 100

type NotProgress<T> = T extends { readonly kind: 'progress' } ? never : T
export type TaskOutcome = NotProgress<OutboundInstruction>

export function outcomeMessages(instruction: TaskOutcome): string[] {
  switch (instruction.kind) {
    case 'result': {
      const messages = split(instruction.text, MAX_TEXT)
      if (instruction.overflowCostUsd !== undefined) {
        messages.push(overflowSpentText(instruction.overflowCostUsd))
      }
      return messages
    }
    case 'failure':
      return split(instruction.reason, MAX_TEXT)
    case 'choice':
      return split(instruction.text, MAX_TEXT)
    case 'stopped':
      return ['Stopped.']
    case 'command-outcome':
      return [commandText(instruction.command, instruction.carriedOut)]
    case 'blocked':
      return [blockedText(instruction.resetsAt)]
    case 'context-full':
      return [
        'Claude cannot shorten this conversation any further, so it cannot take another ' +
          'message. Send /clear to start a fresh session — nothing from this one carries over.',
      ]
    case 'overflow-refused':
      return [
        `Overflow is capped at $${money(instruction.capUsd)} a month and this month has ` +
          `spent $${money(instruction.spentUsd)}, so it is off until the month turns. ` +
          `Your task is still waiting for the shared quota to reset.`,
      ]
  }
}

export function threadName(text: string): string {
  const [first = ''] = text.trim().split('\n')
  return first.trim() === '' ? 'roma' : fitted(first.trim(), MAX_THREAD_NAME)
}

function blockedText(resetsAt: number): string {
  const at = new Date(resetsAt * 1000).toISOString().replace('T', ' ').slice(0, 16)
  return `The shared Claude quota is spent. It comes back at ${at} UTC — I have kept your task and will run it then.`
}

function overflowSpentText(costUsd: number | null): string {
  if (costUsd === null) return 'Ran on metered billing. What it cost was never reported.'
  return `Ran on metered billing: $${money(costUsd)}.`
}

function money(usd: number): string {
  return usd.toFixed(2)
}

export function progressText(progress: TaskProgress): string {
  return fitted(progressPhrase(progress), MAX_TEXT)
}

function fitted(text: string, budget: number): string {
  if (text.length <= budget) return text
  if (budget < 1) return ''
  return `${text.slice(0, Math.max(0, budget - 1))}…`
}

function commandText(command: Command, carriedOut: boolean): string {
  if (command === 'clear') return 'Started a fresh session. Nothing from before this is in it.'
  return carriedOut ? 'Stopping…' : 'Nothing to stop.'
}

function split(text: string, budget: number): string[] {
  if (text.trim() === '') return ['(roma finished without saying anything.)']

  const messages: string[] = []
  let rest = text
  while (rest.length > budget) {
    const window = rest.slice(0, budget)
    const at = breakPoint(window, budget)
    messages.push(window.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest !== '') messages.push(rest)
  return messages
}

function breakPoint(window: string, budget: number): number {
  for (const boundary of ['\n\n', '\n', ' ']) {
    const at = window.lastIndexOf(boundary)
    if (at > budget / 2) return at + boundary.length
  }
  return budget
}
