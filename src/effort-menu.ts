/**
 * The efforts a Caller may put a Session at, which models take one at all, and
 * how `/effort`'s argument is read.
 *
 * The Model Menu's opposite number, and deliberately not its twin (ADR-0016).
 * The Model Menu withholds models because a costlier model is a bigger share of
 * a window everybody stands in and roma cannot check what it hands over. Neither
 * reason survives here: the levels are enumerable, they are all Claude Code's
 * own, and a Caller asking for more thinking on a task they are about to wait
 * for is the feature rather than the risk. So the Menu below holds every level
 * the build has.
 *
 * What it holds back is not a level. `ultracode` is `xhigh` plus dynamic
 * workflow orchestration — the build's own alias table is `{ultracode:"xhigh"}`
 * — which turns one Task into a fleet on a window everybody shares, in a thread
 * where one person's choice is paid for by the others. It is off the Menu and
 * reachable only through `ROMA_EFFORT`, because the Menu bounds Callers and never
 * the operator.
 *
 * **This Menu and this Matrix are a person's judgement about Claude Code
 * 2.1.220** (the ADR-0007 pin), read out of that build, and both must be
 * re-audited when the pin moves. Nothing enforces that — the version is named
 * here so the drift report's working-tree sweep lists this file under what rests
 * on the pin, which is enumeration rather than enforcement. `src/relays.ts`
 * and `src/model-menu.ts` carry the same line for the same reason, and this is
 * the third: the re-audit list is now long enough that "somebody remembers" has
 * stopped being the mechanism.
 */

/**
 * Every level a Caller may ask for.
 *
 * All five of the build's own — `EL = ["low","medium","high","xhigh","max"]`,
 * measured. The build's one alias (`med` for `medium`) is deliberately not here:
 * roma's Menu is roma's outright, nothing is relayed and nothing is compared
 * against Claude Code, so an alias would be a spelling roma had chosen to claim
 * rather than one it inherited.
 *
 * `auto` is not here because it cannot be. `--effort auto` is rejected by the
 * CLI's own parser, so the only way roma could offer it is by omitting `--effort`
 * — which reopens the shared settings file that passing it on every spawn closes.
 * It is not refused; it is incompatible with pinning, and pinning won.
 */
export const EFFORT_MENU: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * The name that means the Pinned Effort.
 *
 * Not a level of its own, for the reason `PINNED_NAME` is not a model: it names
 * whatever `ROMA_EFFORT` resolved to for this deployment, so a Conversation can
 * be put back without clearing what it has said, and a deployment that moves its
 * Pinned Effort does not strand a Session that asked for "default" at the old
 * one.
 */
export const PINNED_EFFORT_NAME = 'default'

/** Every name a Caller may type, in the order `/effort` lists them. */
export const EFFORT_NAMES: readonly string[] = [...EFFORT_MENU, PINNED_EFFORT_NAME]

/**
 * `xhigh` plus dynamic workflow orchestration, which is not a sixth level.
 *
 * Named here so that the one place allowed to accept it — `ROMA_EFFORT`, read by
 * an operator's hand — can do so without spelling a string of its own, and so
 * that `EFFORT_MENU` not containing it reads as a decision rather than an
 * omission. Whether a Caller may ever reach it is deferred to its own ticket,
 * and deliberately deferred until the Audit Record has effort figures to argue
 * it with (ADR-0016, following ADR-0014's "record the model first, then look").
 */
export const ULTRACODE = 'ultracode'

/**
 * Which of the Model Menu's models take an effort at all, on the pinned build.
 *
 * Extracted rather than transcribed — `scripts/claude-code-effort-matrix.ts` is
 * what reads it out of the binary, and its output is reviewed by a person before
 * it becomes this constant. Against 2.1.220 exactly one row says no.
 *
 * **Two of these three rows are a person's inference and not the extractor's
 * reading, and the difference is worth knowing before editing them.** The gate
 * refuses by name and allows by name, and roma's other two models are on neither
 * list: what decides them is `M$(r,"effort")`, a server-side entitlement the
 * bundle does not contain. So the extractor reports `claude-haiku-4-5` as a
 * refusal and the other two as *unnamed*, and `true` here is read off what the
 * build says about itself elsewhere — `xhigh` describes itself as
 * `Deeper reasoning than high, just below maximum (Fable 5, Opus 4.7+,
 * Sonnet 5)`. That is the relationship ADR-0016 designed: the script prints and
 * the person decides, because the script has been wrong before and could not
 * tell.
 *
 * **It reports; it does not gate.** roma uses it for two things and refuses
 * nothing because of it: it says so, in the reply to an `/effort` or a `/model`
 * that has just made the setting inert, and it records so, on the Audit Record.
 * Setting `max` on haiku costs no more than `low` does — the harm is a false
 * belief, and a false belief is answered with a sentence. Dressing this as a
 * spending boundary would be borrowing authority the facts do not support, and
 * would hand a reading of a minified binary — one that has already been wrong
 * once — the power to turn away something a Caller asked for.
 *
 * Keyed by the resolved model id rather than by the Menu's names, because that
 * is what a Session actually runs on: a Pinned Model an operator set off the
 * Menu arrives here as an id and no name at all.
 */
export const EFFORT_MATRIX: Readonly<Record<string, boolean>> = {
  'claude-opus-5': true,
  'claude-sonnet-5': true,
  'claude-haiku-4-5': false,
}

/**
 * Whether this model takes an effort, or null where the Matrix does not say.
 *
 * Three answers rather than two, and the third is the honest one for a model the
 * Matrix has never been read about — which is what a deployment that pinned
 * something off the Model Menu has. Defaulting it to yes would have roma assert
 * a fact it has not established; defaulting it to no would have roma tell a
 * Caller their setting is inert when it may well not be. Null says neither, and
 * every caller here treats it as "say nothing extra".
 */
export function takesEffort(model: string): boolean | null {
  return EFFORT_MATRIX[model] ?? null
}

/**
 * What the Audit Record carries in place of a level, where the Matrix says the
 * model takes none.
 *
 * Deliberately not spelled like a level, so a ledger read months later cannot
 * mistake it for one. ADR-0016 asks the record to say the effort did not apply
 * rather than name a level nothing ran at, and this is that sentence in one
 * word.
 */
export const EFFORT_NOT_APPLIED = 'not-applied'

/** What an `/effort` message is asking for. */
export type EffortRequest =
  | {
      /**
       * What effort this Session runs at, and what else it may run at.
       *
       * `/effort` with no argument. Claude Code's own `/effort` answers that with
       * a report too, and roma still does not relay it: roma owns the answer, so
       * asking costs no process, no Turn and no money, and never queues behind
       * whatever the Conversation is waiting on.
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
       * operator's and not a Caller's.
       *
       * Refused rather than passed on as work, for `ModelRequest`'s reason: the
       * Caller Marker goes above the message, so Claude Code never sees a command
       * at all and somebody is billed for a Turn that answers a plausible
       * sentence about their typo.
       */
      readonly kind: 'unknown'
      readonly name: string
    }

/**
 * Read what an `/effort` Command was asking for.
 *
 * Total, and it takes the argument the Command reader already separated rather
 * than the message — `readModelRequest`'s rule, for `readModelRequest`'s reason:
 * which messages are `/effort` at all is `readCommand`'s single answer, and a
 * second parser here would be a second answer to it.
 */
export function readEffortRequest(argument: string | null): EffortRequest {
  if (argument === null) return { kind: 'report' }
  if (argument === PINNED_EFFORT_NAME) return { kind: 'default' }
  if (!EFFORT_MENU.includes(argument)) return { kind: 'unknown', name: argument }
  return { kind: 'chosen', level: argument }
}

/**
 * Whether an operator may pin this effort, which is a wider question than what a
 * Caller may choose.
 *
 * The Menu plus `ultracode`, and `default` deliberately not among them: it names
 * the Pinned Effort, so a deployment pinning it would be naming itself.
 *
 * Asked at boot and answered locally, with no process involved. It is the one
 * wrong-effort failure that needs no measurement to catch, and missing it is
 * expensive: an unrecognised `--effort` does not fail the spawn — it warns on
 * stderr, starts, and runs on the build's own default — so roma would be wrong
 * about the effort of every Session it serves and nothing would stop.
 */
export function isPinnableEffort(value: string): boolean {
  return EFFORT_MENU.includes(value) || value === ULTRACODE
}
