export const JUDGED_AGAINST_CLAUDE_CODE = '2.1.220'

export type RelayCost = 'free' | 'paid'

interface RelayEntry {
  readonly cost: RelayCost
  readonly takesArgument: boolean
}

const RELAYS: ReadonlyMap<string, RelayEntry> = new Map(
  Object.entries({
    '/context': { cost: 'free', takesArgument: false },
    '/compact': { cost: 'paid', takesArgument: true },
  }),
)

export interface RelayRequest {
  readonly command: string
  readonly argument: string | null
  readonly cost: RelayCost
}

export function readRelay(text: string): RelayRequest | null {
  const message = text.trim()

  const spelling = message.toLowerCase()
  const whole = entryFor(spelling)
  if (whole !== undefined) return { command: spelling, argument: null, cost: whole.cost }

  const split = /^(\S+)\s+([\s\S]+)$/.exec(message)
  if (split === null) return null
  const command = (split[1] ?? '').toLowerCase()
  const head = entryFor(command)
  if (head === undefined || !head.takesArgument) return null

  return { command, argument: split[2] ?? '', cost: head.cost }
}

function entryFor(spelling: string): RelayEntry | undefined {
  return RELAYS.get(spelling)
}

export function relaySpellings(): readonly string[] {
  return [...RELAYS.keys()]
}
