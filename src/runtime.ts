export type Runtime = 'claude-code'

/** Every Runtime roma can name, in the order a month's figures are reported in. */
export const RUNTIMES: readonly Runtime[] = ['claude-code']

/** Enforced by `fence:session-runtime-has-a-name`. */
export const RUNTIME_NAMES: Readonly<Record<Runtime, string>> = {
  'claude-code': 'Claude Code',
}
