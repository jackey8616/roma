/**
 * The efforts a Caller may put a Session at, which models take one at all, and
 * how `/effort`'s argument is read.
 *
 * This Menu and this Matrix are read out of Claude Code 2.1.220 (the ADR-0007
 * pin), and both must be re-audited when the pin moves. Nothing enforces that:
 * the version is named here so the drift report's working-tree sweep lists this
 * file.
 */

/**
 * Every level a Caller may ask for: all five of the build's own, and no alias.
 * `auto` is not here because it cannot be pinned.
 * Enforced by `fence:menu-effort-offers-no-auto`.
 */
export const EFFORT_MENU: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * The name that means the Pinned Effort: not a level, but whatever `ROMA_EFFORT`
 * resolves to, so a Session that asked for it follows the deployment when the
 * pin moves.
 */
export const PINNED_EFFORT_NAME = 'default'

/** Every name a Caller may type, in the order `/effort` lists them. */
export const EFFORT_NAMES: readonly string[] = [...EFFORT_MENU, PINNED_EFFORT_NAME]

/**
 * `xhigh` plus dynamic workflow orchestration, which is not a sixth level. Only
 * `ROMA_EFFORT` accepts it; no Caller may ask for it.
 */
export const ULTRACODE = 'ultracode'

/**
 * Which of the Model Menu's models take an effort at all, on the pinned build,
 * keyed by resolved model id rather than Menu name. Three of the four `true`
 * rows are a person's inference, not the extractor's reading.
 * Enforced by `fence:menu-fable-takes-effort`.
 *
 * It reports and never gates: roma refuses nothing because of it.
 */
export const EFFORT_MATRIX: Readonly<Record<string, boolean>> = {
  'claude-fable-5': true,
  'claude-opus-5': true,
  'claude-sonnet-5': true,
  'claude-haiku-4-5': false,
}

/**
 * Whether this model takes an effort, or null where the Matrix does not say —
 * which is what a deployment that pinned something off the Model Menu has, and
 * every caller treats as "say nothing extra".
 * Enforced by `fence:menu-effort-unread-model-says-nothing`.
 */
export function takesEffort(model: string): boolean | null {
  return Object.hasOwn(EFFORT_MATRIX, model) ? (EFFORT_MATRIX[model] ?? null) : null
}

/**
 * What the Audit Record carries in place of a level, where the Matrix says the
 * model takes none: not spelled like any level.
 */
export const EFFORT_NOT_APPLIED = 'not-applied'

/** What an `/effort` message is asking for. */
export type EffortRequest =
  | {
      /**
       * What effort this Session runs at, and what else it may run at: `/effort`
       * with no argument. roma answers it alone and never relays it, so asking
       * costs no process, no Turn and no money, and never queues behind whatever
       * the Conversation is waiting on.
       */
      readonly kind: 'report'
    }
  | {
      /** A level on the Menu. The name and the level are one string here. */
      readonly kind: 'chosen'
      readonly level: string
    }
  | {
      /** Back to the Pinned Effort, whatever this deployment resolved it to. */
      readonly kind: 'default'
    }
  | {
      /**
       * A level roma does not offer — a typo, or `ultracode`, which is the
       * operator's and not a Caller's. Refused rather than passed on as work.
       * Enforced by `fence:menu-effort-unknown-is-refused`.
       */
      readonly kind: 'unknown'
      readonly name: string
    }

/**
 * Read what an `/effort` Command was asking for. Total, and it takes the argument
 * `readCommand` already separated rather than the message: which messages are
 * `/effort` at all is that function's single answer.
 */
export function readEffortRequest(argument: string | null): EffortRequest {
  if (argument === null) return { kind: 'report' }
  if (argument === PINNED_EFFORT_NAME) return { kind: 'default' }
  if (!EFFORT_MENU.includes(argument)) return { kind: 'unknown', name: argument }
  return { kind: 'chosen', level: argument }
}

/**
 * Whether an operator may pin this effort: the Menu plus `ultracode`, and not
 * `default`, which names the Pinned Effort itself. Asked at boot and answered
 * locally, with no process involved.
 * Enforced by `fence:menu-effort-pin-refused-at-boot`.
 */
export function isPinnableEffort(value: string): boolean {
  return EFFORT_MENU.includes(value) || value === ULTRACODE
}
