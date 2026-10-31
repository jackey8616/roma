export const EFFORT_MENU: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const PINNED_EFFORT_NAME = 'default'

export const EFFORT_NAMES: readonly string[] = [...EFFORT_MENU, PINNED_EFFORT_NAME]

export const ULTRACODE = 'ultracode'

export const EFFORT_MATRIX: Readonly<Record<string, boolean>> = {
  'claude-fable-5': true,
  'claude-opus-5': true,
  'claude-sonnet-5': true,
  'claude-haiku-4-5': false,
}

export function takesEffort(model: string): boolean | null {
  return Object.hasOwn(EFFORT_MATRIX, model) ? (EFFORT_MATRIX[model] ?? null) : null
}

export const EFFORT_NOT_APPLIED = 'not-applied'

export type EffortRequest =
  | {
      readonly kind: 'report'
    }
  | {
      readonly kind: 'chosen'
      readonly level: string
    }
  | {
      readonly kind: 'default'
    }
  | {
      readonly kind: 'unknown'
      readonly name: string
    }

export function readEffortRequest(argument: string | null): EffortRequest {
  if (argument === null) return { kind: 'report' }
  if (argument === PINNED_EFFORT_NAME) return { kind: 'default' }
  if (!EFFORT_MENU.includes(argument)) return { kind: 'unknown', name: argument }
  return { kind: 'chosen', level: argument }
}

export function isPinnableEffort(value: string): boolean {
  return EFFORT_MENU.includes(value) || value === ULTRACODE
}
