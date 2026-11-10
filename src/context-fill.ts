import type { ContextHeld } from './stream-events.js'

export const NEARLY_FULL_PERCENT = 80

export function percentFull(held: ContextHeld, window: number): number {
  return Math.round((held.tokens / window) * 100)
}

export function nearlyFull(held: ContextHeld | null, window: number | null): number | null {
  if (held === null || window === null) return null
  const percent = percentFull(held, window)
  return percent >= NEARLY_FULL_PERCENT ? percent : null
}

export function withNearlyFull(text: string, percent: number | undefined): string {
  if (percent === undefined) return text
  const note = nearlyFullText(percent)
  return text === '' ? note : `${text}\n\n${note}`
}

export function nearlyFullText(percent: number): string {
  return (
    `Context is ${percent}% full. Autocompact will trigger soon, which discards older ` +
    `messages. Use /compact now to control what gets kept.`
  )
}
