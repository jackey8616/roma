export const JUDGED_AGAINST_CLAUDE_CODE = '2.1.319'

export const MENU: Readonly<Record<string, string>> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

export const PINNED_NAME = 'default'

export const MENU_NAMES: readonly string[] = [...Object.keys(MENU), PINNED_NAME]

export type ModelRequest =
  | {
      readonly kind: 'report'
    }
  | {
      readonly kind: 'chosen'
      readonly name: string
      readonly model: string
    }
  | {
      readonly kind: 'default'
    }
  | {
      readonly kind: 'unknown'
      readonly name: string
    }

export function menuNameFor(model: string): string | null {
  return Object.entries(MENU).find(([, offered]) => offered === model)?.[0] ?? null
}

export function readModelRequest(argument: string | null): ModelRequest {
  if (argument === null) return { kind: 'report' }
  if (argument === PINNED_NAME) return { kind: 'default' }
  const model = Object.hasOwn(MENU, argument) ? MENU[argument] : undefined
  if (model === undefined) return { kind: 'unknown', name: argument }
  return { kind: 'chosen', name: argument, model }
}
