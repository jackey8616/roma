/**
 * Which agent CLI serves a Session's Turns, as the closed set roma can name.
 *
 * A module of its own rather than a field of the Audit Records' or a second
 * export of `build-env.ts`. A Runtime is a property of a Session
 * (`CONTEXT.md`), and ADR-0025 gives the Session's record, the Opening and
 * `/config` the same word — none of which should reach into the ledger to say
 * what a Session runs on, and `build-env.ts` builds one Runtime's environment
 * rather than standing above both.
 */

/**
 * The agent CLI serving one Session's Turns (`CONTEXT.md`).
 *
 * One value, and that is the whole of it: Claude Code is required, Codex is
 * optional and not built (ADR-0025). What the field on an Audit Record buys
 * while it has one value is the distinction it exists for — a record naming a
 * Runtime roma cannot name is unreadable rather than counted as this one.
 */
export type Runtime = 'claude-code'

/**
 * Every Runtime roma can name, and the order a month's figures are reported in.
 *
 * **A named list does not grow on its own** (ADR-0025). A second entry is a
 * deliberate act, and it is the same act three times over: it gives `/usage` a
 * second Runtime's lines, it stops a record naming that Runtime being
 * unreadable, and it is what makes two Shared Windows two figures.
 */
export const RUNTIMES: readonly Runtime[] = ['claude-code']

/**
 * How a Runtime is spelled to whoever is reading a figure.
 *
 * Beside the list rather than in the report that prints it, because the name is
 * the Runtime's own — ADR-0025 has the Opening and `/config` naming one too —
 * and because `Record<Runtime, string>` makes a Runtime added without a name a
 * compile error rather than a line that reads `claude-code`.
 */
export const RUNTIME_NAMES: Readonly<Record<Runtime, string>> = {
  'claude-code': 'Claude Code',
}
