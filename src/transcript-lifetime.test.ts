import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sources } from '../test/support/sources.js'

/**
 * "The Transcript is not roma's to delete" is a claim, and this is where it is
 * kept.
 *
 * ADR-0006 upholds ADR-0003's sentence rather than overturning it: roma names
 * the directory the Transcript lives in, reads nothing out of it, and removes
 * nothing from it. That is a decision rather than an accident, which is why it
 * needs a guard — the code that would break it is code somebody writes while
 * fixing something else, and it would look reasonable.
 *
 * Enforced by reading the sources, in the idiom `provisioning.test.ts` and
 * `core.test.ts` use, and for the same reason: the day it stops being true is a
 * day nobody would otherwise notice. The Transcript is the only account there is
 * of what an agent did (ADR-0005), so the failure mode is not a bug report — it
 * is evidence that is simply gone.
 *
 * Binds `src/channels/` too, the way `provisioning.test.ts` does and
 * `core.test.ts` does not. A Channel Adapter has even less business reaching
 * into a config directory than the Core does, and `main.ts` — where the whole
 * configuration is read and handed on — is the file most able to break this.
 *
 * Note what is *not* forbidden: deletion. `session-pool.ts` deletes working
 * directories on the reclaim timer and `startup.ts` deletes the self-check's
 * throwaway probe directory. Both are right. The line is the config directory,
 * not the verb.
 */
describe('the Transcript is not roma’s to delete', () => {
  /**
   * The structural fact the claim rests on, pinned as an allowlist.
   *
   * A config directory reaches exactly three files: read out of the environment,
   * turned into two variables in a process environment, and passed between the
   * two. `SessionPool` — the one thing that deletes on a timer — is handed
   * `envs`, already-built maps of strings, and never the directory that went
   * into them. It therefore *cannot* address a Transcript, whatever anyone later
   * asks it to do.
   *
   * An allowlist rather than a search for path-building idioms, because that
   * search is the one that fails quietly: `join`, `resolve`, `+ '/'` and a
   * template literal are all the same intent, and a guard that enumerates them
   * is a guard with a gap in it. Nothing can delete what it cannot name, so the
   * naming is what is policed.
   */
  it('lets only the files that build a process environment name a config directory', () => {
    const offenders = sources()
      .filter(({ file }) => !ENVIRONMENT_BUILDERS.includes(file))
      .filter(({ source }) => NAMES_A_CONFIG_DIR.test(codeOnly(source)))

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  /**
   * And within those three, the directory is only ever *passed*, never entered.
   *
   * `build-env.ts` puts it in a map, `env-config.ts` reads it out of the
   * environment, `startup.ts` hands it from one to the other. None of them joins
   * anything onto it, opens anything under it, or removes anything from it —
   * which is the whole of "names the directory, reads nothing out of it, removes
   * nothing from it" made mechanical.
   */
  it('never joins, reads or deletes anything under one', () => {
    const offenders = sources().filter(({ source }) => reachesInside(source))

    expect(offenders.map(({ file }) => file)).toEqual([])
  })
})

/**
 * The three files a config directory legitimately reaches, relative to `src/`.
 *
 * Adding a fourth is not automatically wrong — but it is the moment to ask what
 * it wants the directory *for*, which is the question this test exists to force.
 */
const ENVIRONMENT_BUILDERS = ['env-config.ts', 'build-env.ts', 'startup.ts']

/** Naming the place a Claude Code process keeps its state. */
const NAMES_A_CONFIG_DIR = /\b(configDir|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR)\b/

/**
 * Reaching into it rather than passing it on.
 *
 * Path construction, reading, and removal together, because ADR-0006 forbids all
 * three and they fail the same way. `readdirSync` and `readFileSync` are here
 * for the "reads nothing out of it" half, which is ADR-0005's and older than
 * this decision.
 */
const ENTERS = /\b(join|resolve|relative|basename|dirname|rmSync|rm|rmdirSync|unlinkSync|unlink|readdirSync|readFileSync|createReadStream|existsSync|statSync|globSync)\b/

/**
 * A config directory used in a way that enters it.
 *
 * Windowed over three lines rather than matched inside one call, because a call
 * wrapped by the formatter puts `join(` and `configDir` on different lines, and
 * a regex that assumed one line would miss exactly the code this is for. String
 * concatenation and template interpolation are covered by the same window — they
 * need a separator character next to the directory, and that is what the second
 * pattern looks for.
 */
function reachesInside(source: string): boolean {
  const lines = codeOnly(source).split('\n')
  return lines.some((line, index) => {
    if (!NAMES_A_CONFIG_DIR.test(line)) return false
    const window = lines.slice(Math.max(0, index - 1), index + 2).join('\n')
    return ENTERS.test(window) || CONCATENATES.test(window)
  })
}

/** `configDir + '/projects/'`, and the template-literal spelling of it. */
const CONCATENATES = /\bconfigDir\b\s*\+|\$\{\s*configDir\s*\}\s*[/\\]/

/**
 * The source with its prose taken out.
 *
 * These files explain the config directory at length — `build-env.ts` has a
 * paragraph on it, and `startup-self-check.ts` names both variables inside a
 * sentence it prints to an operator. Documentation mentioning the directory is
 * the documentation working, not the boundary breaking, so comments go, and so
 * do string literals containing a space: prose. A path fragment
 * (`'projects'`, `'/projects/'`) has no space in it and survives, which is the
 * half that matters.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (literal) => (/ /.test(literal) ? '' : literal))
}
