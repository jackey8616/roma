/**
 * The models a Caller may put a Session on, and how `/model`'s argument is read.
 *
 * The Menu, and the whole of what stops one person moving everybody's Shared
 * Window onto something costlier without anybody agreeing to it (ADR-0014).
 * Everyone draws on one subscription token (ADR-0002) and a thread is many people
 * sharing one Session, so the person who pays for a costlier model is usually not
 * the person who chose it.
 *
 * **An offer rather than a filter.** Claude Code's own `/model` says what it
 * takes: `` `/model <name>. Available: …, default, or a full model ID.` `` — so
 * there is no list roma could hold that would be a complete check, and this is a
 * decision about what roma is *willing* to put the shared window behind rather
 * than an attempt to enumerate what works. It is also what makes the check local
 * and immediate: an unknown name is refused in the reply to the message that
 * carried it, addressed to whoever typed it, rather than surfacing later as a
 * process that will not start on somebody else's message.
 *
 * **This Menu is a person's judgement about Claude Code 2.1.220** (the ADR-0007
 * pin), read out of that build's own alias table, and it must be re-audited when
 * the pin moves. Nothing enforces that — the version is named here so the drift
 * report's working-tree sweep lists this file under what rests on the pin, which
 * is enumeration rather than enforcement. `src/relays.ts` carries the same line
 * for the same reason.
 */

/**
 * What each name a Caller may type resolves to.
 *
 * The resolved ids rather than the aliases, because roma passes `--model` the id
 * and files it on the Audit Record: `PINNED_MODEL` is `claude-sonnet-5`, a Caller
 * types `sonnet`, and the two spellings have to come out as one model or the
 * ledger has two names for it.
 *
 * That `sonnet` resolves to the same string `PINNED_MODEL` holds is a coincidence
 * of what this deployment pins, and the two are deliberately not one constant: an
 * operator moving `ROMA_MODEL` moves the Pinned Model and moves nothing here,
 * because `sonnet` is Claude Code's name for one model and not roma's name for
 * whichever model it happens to be pinned to.
 *
 * Deliberately not here: the `[1m]` variants, which Claude Code declares as
 * `opus[1m]` and `sonnet[1m]` at `5x more context`. That multiplier is context
 * rather than price, and it is off the Menu because more context per Turn is
 * still more of a window everybody shares.
 */
export const MENU: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
}

/**
 * The name that means the Pinned Model.
 *
 * Not a model of its own: it names whatever `ROMA_MODEL` resolved to for this
 * deployment, so that a Conversation can be put back without clearing what it has
 * said — and so that a deployment moving its Pinned Model does not leave a
 * Session that asked for "default" on the old one.
 */
export const PINNED_NAME = 'default'

/** Every name a Caller may type, in the order `/model` lists them. */
export const MENU_NAMES: readonly string[] = [...Object.keys(MENU), PINNED_NAME]

/** What a `/model` message is asking for. */
export type ModelRequest =
  | {
      /**
       * Which model this Session is on, and what else it may be on.
       *
       * `/model` with no argument. Claude Code's own no-argument `/model` is an
       * interactive picker, which a Channel cannot render — reporting is what
       * that gesture can honestly mean in a text channel, and roma can answer it
       * without a process, without a Turn and without money, because it owns the
       * answer.
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
       * A name roma does not offer.
       *
       * Refused rather than passed on as work, because falling through is
       * precisely the fault this feature exists to fix: the Caller Marker goes
       * above the message, so Claude Code never sees a command at all, and
       * somebody is billed for a Turn that answers a plausible sentence about
       * their typo.
       */
      readonly kind: 'unknown'
      readonly name: string
    }

/**
 * Read what a `/model` Command was asking for.
 *
 * Total, and it takes the argument the Command reader already separated rather
 * than the message: which messages are `/model` at all — the head, the
 * whitespace, the casing, and the rule that one argument is an argument and three
 * words are prose — is `readCommand`'s single answer, and a second parser here
 * would be a second answer to it.
 */
/**
 * What a Caller would type to ask for this model, or null where nothing would.
 *
 * The reverse of the table above, for saying which model a Session is on: roma
 * keeps the resolved id, and a report that named only that would offer a list of
 * aliases against a model spelled another way — leaving the person to map one
 * vocabulary onto the other, and to find out by being refused that the id itself
 * is not something they may type.
 *
 * Null for a Pinned Model the Menu does not carry, which is what a deployment
 * that set `ROMA_MODEL` to something off it has. That is reported as the bare id,
 * because it is the truthful answer and there is no name for it.
 */
export function menuNameFor(model: string): string | null {
  return Object.entries(MENU).find(([, offered]) => offered === model)?.[0] ?? null
}

export function readModelRequest(argument: string | null): ModelRequest {
  if (argument === null) return { kind: 'report' }
  if (argument === PINNED_NAME) return { kind: 'default' }
  const model = MENU[argument]
  if (model === undefined) return { kind: 'unknown', name: argument }
  return { kind: 'chosen', name: argument, model }
}
