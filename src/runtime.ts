export type Runtime = 'claude-code'

export const RUNTIMES: readonly Runtime[] = ['claude-code']

export const RUNTIME_NAMES: Readonly<Record<Runtime, string>> = {
  'claude-code': 'Claude Code',
}
