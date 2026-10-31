/**
 * The Model Menu, and how `/model`'s argument is read. A person's judgement
 * about Claude Code 2.1.220, re-audited when the pin moves.
 * Enforced by `fence:pin-lists-name-the-version`.
 */

/**
 * What each name a Caller may type resolves to: the model id roma passes
 * `--model` and files on the Audit Record, never the alias. Independent of
 * `PINNED_MODEL`, so moving `ROMA_MODEL` moves nothing here.
 *
 * Ordered most expensive first, the order every Channel draws.
 * Enforced by `fence:menu-model-ordered-by-cost`.
 */
export const MENU: Readonly<Record<string, string>> = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
}

/**
 * The name that means the Pinned Model: whatever `ROMA_MODEL` resolved to, so a
 * Session on it follows a deployment that moves its Pinned Model.
 */
export const PINNED_NAME = 'default'

/** Every name a Caller may type, in the order `/model` lists them. */
export const MENU_NAMES: readonly string[] = [...Object.keys(MENU), PINNED_NAME]

/** What a `/model` message is asking for. */
export type ModelRequest =
  | {
      /**
       * `/model` with no argument: which model this Session is on, and what else
       * it may be on. roma answers it without a process or a Turn.
       * Enforced by `fence:core-model-never-relayed`.
       */
      readonly kind: 'report'
    }
  | {
      /** A name on the Menu, and what it resolves to. */
      readonly kind: 'chosen'
      readonly name: string
      readonly model: string
    }
  | {
      /** Back to the Pinned Model, whatever this deployment resolved it to. */
      readonly kind: 'default'
    }
  | {
      /**
       * A name roma does not offer, refused rather than passed on as work.
       * Enforced by `fence:menu-model-unknown-is-refused`.
       */
      readonly kind: 'unknown'
      readonly name: string
    }

/**
 * What a Caller would type to ask for this model: `MENU` read backwards. Null
 * for a Pinned Model the Menu does not carry, which is reported as the bare id.
 */
export function menuNameFor(model: string): string | null {
  return Object.entries(MENU).find(([, offered]) => offered === model)?.[0] ?? null
}

/**
 * Read what a `/model` Command was asking for. Total, and it takes the argument
 * `readCommand` already separated, not the message.
 */
export function readModelRequest(argument: string | null): ModelRequest {
  if (argument === null) return { kind: 'report' }
  if (argument === PINNED_NAME) return { kind: 'default' }
  const model = Object.hasOwn(MENU, argument) ? MENU[argument] : undefined
  if (model === undefined) return { kind: 'unknown', name: argument }
  return { kind: 'chosen', name: argument, model }
}
