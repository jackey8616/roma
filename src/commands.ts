export type Command = 'stop' | 'clear' | 'model' | 'effort' | 'caveman' | 'config' | 'usage'

export interface CommandRequest {
  readonly command: Command
  readonly argument: string | null
}

const COMMANDS: ReadonlyMap<string, Command> = new Map(
  Object.entries({
    '/stop': 'stop',
    '/clear': 'clear',
    '/reset': 'clear',
    '/new': 'clear',
    '/model': 'model',
    '/effort': 'effort',
    '/caveman': 'caveman',
    '/config': 'config',
    '/settings': 'config',
    '/usage': 'usage',
    '/cost': 'usage',
    '/stats': 'usage',
  }),
)

const TAKES_AN_ARGUMENT: ReadonlyMap<string, Command> = new Map(
  Object.entries({
    '/model': 'model',
    '/effort': 'effort',
    '/caveman': 'caveman',
    '/config': 'config',
  }),
)

export function commandSpellings(): readonly string[] {
  return [...COMMANDS.keys()]
}

export function commandFor(
  command: Extract<Command, 'model' | 'effort' | 'caveman'>,
  argument: string,
): string {
  return `/${command} ${argument}`
}

export function readCommand(text: string): CommandRequest | null {
  const message = text.trim().toLowerCase()

  const whole = COMMANDS.get(message)
  if (whole !== undefined) return { command: whole, argument: null }

  const [head = '', argument, ...rest] = message.split(/\s+/)
  if (argument === undefined || rest.length > 0) return null

  const withArgument = TAKES_AN_ARGUMENT.get(head)
  return withArgument === undefined ? null : { command: withArgument, argument }
}
