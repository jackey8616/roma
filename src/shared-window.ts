import type { SharedWindow } from './stream-events.js'

const REJECTED = 'rejected'

export function spentUntil(window: SharedWindow): number | null {
  if (window.status !== REJECTED) return null
  return window.resetsAt
}

export function overflowOffer(window: SharedWindow): boolean {
  if (window.overageStatus === null || window.overageStatus === REJECTED) return false
  return window.isUsingOverage !== true
}
