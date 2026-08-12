import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CAVEMAN_MENU,
  CAVEMAN_OFF,
  cavemanRuleset,
  isPinnableCaveman,
  OFF_MENU_WENYAN,
} from './caveman.js'

/** Every level an operator may pin, which is the Menu plus the two off it. */
const EVERY_LEVEL = [...CAVEMAN_MENU, ...OFF_MENU_WENYAN]

/** Every level that has a ruleset, which is every level except `off`. */
const LEVELS_WITH_RULES = EVERY_LEVEL.filter((level) => level !== CAVEMAN_OFF)

describe('what an operator may pin', () => {
  it('takes every level a Caller will be able to choose', () => {
    for (const level of CAVEMAN_MENU) expect(isPinnableCaveman(level)).toBe(true)
  })

  // The Menu bounds Callers and never the operator, exactly as `ROMA_EFFORT` may
  // already name `ultracode`. These two are held back because wenyan's own row
  // claims its saving in characters and roma is spent in tokens (ADR-0030).
  it('takes the two wenyan levels the Menu holds back', () => {
    for (const level of OFF_MENU_WENYAN) {
      expect(isPinnableCaveman(level)).toBe(true)
      expect(CAVEMAN_MENU).not.toContain(level)
    }
  })

  it('takes seven levels and no more', () => {
    expect(EVERY_LEVEL).toHaveLength(7)
  })

  // `off` is a level like any other here, and pinning it is what every
  // deployment that names nothing already has.
  it('takes off, which is a level and not the absence of one', () => {
    expect(isPinnableCaveman(CAVEMAN_OFF)).toBe(true)
  })

  // The alias caveman's own hook rewrites to `wenyan-full`. roma appends its own
  // text and relays nothing to that hook, so accepting it would be roma claiming
  // a second spelling for a level it already has one for — `EFFORT_MENU`'s
  // argument against `med`, at higher stakes, because the Audit Record would
  // then carry two spellings for one level (ADR-0030).
  it('does not take wenyan, which is an alias rather than a level', () => {
    expect(isPinnableCaveman('wenyan')).toBe(false)
  })

  // caveman's three `INDEPENDENT_MODES`. Its hook answers each with one line
  // deferring to a `/caveman-<mode>` skill, and roma installs none of them — so
  // pinning one would append a sentence pointing at nothing.
  it('does not take the three modes that defer to skills roma does not install', () => {
    for (const mode of ['commit', 'review', 'compress']) {
      expect(isPinnableCaveman(mode)).toBe(false)
    }
  })

  it('does not take a level nothing downstream would ever refuse', () => {
    expect(isPinnableCaveman('bananas')).toBe(false)
    expect(isPinnableCaveman('FULL')).toBe(false)
    expect(isPinnableCaveman('')).toBe(false)
  })
})

describe('the ruleset roma appends', () => {
  // Not the ruleset filtered to a level called off, which is several thousand
  // characters of instructions with an empty intensity table in the middle of
  // it. caveman's own hook exits before filtering for the same reason, and the
  // count is in ADR-0030.
  it('is no text at all where the Caveman is off', () => {
    expect(cavemanRuleset(CAVEMAN_OFF)).toBe('')
  })

  it('says which level is in force in its first line', () => {
    for (const level of LEVELS_WITH_RULES) {
      expect(cavemanRuleset(level).split('\n')[0]).toBe(`CAVEMAN MODE ACTIVE — level: ${level}`)
    }
  })
})

describe('the intensity the ruleset asks for', () => {
  // One row of caveman's intensity table survives per level, which is the whole
  // of what one level's ruleset differs by.
  it('keeps the pinned level’s row and drops the other five', () => {
    for (const level of LEVELS_WITH_RULES) {
      const rules = cavemanRuleset(level)
      expect(rules).toContain(`| **${level}** |`)
      for (const other of LEVELS_WITH_RULES.filter((each) => each !== level)) {
        expect(rules).not.toContain(`| **${other}** |`)
      }
    }
  })

  // The header and the separator match neither of the filter's two patterns, so
  // the surviving row arrives inside a table rather than as a loose line.
  it('leaves the table it is a row of standing', () => {
    for (const level of LEVELS_WITH_RULES) {
      expect(cavemanRuleset(level)).toContain('| Level | What change |\n|-------|------------|\n')
    }
  })

  // Worked examples, one per level per question, and the same rule applies to
  // them: a Session asked to be `lite` is shown what `lite` looks like and not
  // what five other levels look like.
  it('keeps the pinned level’s examples and drops the other levels’', () => {
    for (const level of LEVELS_WITH_RULES) {
      const rules = cavemanRuleset(level)
      expect(rules).toContain(`\n- ${level}: `)
      for (const other of LEVELS_WITH_RULES.filter((each) => each !== level)) {
        expect(rules).not.toContain(`\n- ${other}: `)
      }
    }
  })

  // Prose rather than examples: the filter's example pattern wants a colon after
  // a single token, and every bullet under `Drop caveman when:` is a phrase.
  it('keeps the Auto-Clarity bullets, which are not examples of anything', () => {
    for (const level of LEVELS_WITH_RULES) {
      expect(cavemanRuleset(level)).toContain('\n- Security warnings\n')
    }
  })
})

/**
 * caveman's own `SKILL.md`, at the commit roma's ruleset was derived from.
 *
 * **Never read at runtime, and structurally so rather than by promise.**
 * `.dockerignore` drops `test` and `*.md` from the build context outright, so
 * this file is not in the image the builder stage sees; `tsconfig.build.json`
 * includes `src` alone, so nothing under here compiles; and the runtime stage
 * copies `dist/` and nothing else. There is no `readFileSync` a shipped roma
 * could make that would find it and no import that would resolve to it. A `.md`
 * under `src/` would fail the first of those three.
 */
function upstreamSkill(): string {
  return readFileSync(new URL('../test/fixtures/caveman/SKILL.md', import.meta.url), 'utf8')
}

/**
 * The half of it roma borrowed, by caveman's own hook's rule.
 *
 * Its frontmatter is stripped with the hook's own expression, and what that
 * throws away is the part that makes the file a skill at all — a name, and the
 * trigger-phrase description that would wait to be elected and never be. Only
 * the body was ever the ruleset.
 */
function upstreamBody(): string {
  return upstreamSkill().replace(/^---[\s\S]*?---\s*/, '')
}

describe('the three lines that describe a machine roma does not install', () => {
  // The phrase works because `caveman-mode-tracker.js` watches `UserPromptSubmit`
  // for it, and roma installs no tracker. Left in, roma's record would say `full`
  // while the model had stopped (ADR-0030).
  it('offers no way to turn it off in prose', () => {
    for (const level of LEVELS_WITH_RULES) {
      expect(cavemanRuleset(level)).not.toContain('stop caveman')
      expect(cavemanRuleset(level)).not.toContain('normal mode')
    }
  })

  // Upstream advertises seven values on a line a Caller could act on. roma draws
  // no Menu and answers no `/caveman` yet, so any mention of one would bill
  // somebody for a Turn explaining that it does nothing.
  it('advertises no Command, and so cannot advertise a value roma does not offer', () => {
    for (const level of LEVELS_WITH_RULES) expect(cavemanRuleset(level)).not.toContain('/caveman')
  })

  // The line that hardcoded `full`. What it names now is a runtime value, which
  // is why the ruleset is a template rather than six finished strings.
  it('names the level in force where caveman hardcodes its own default', () => {
    for (const level of LEVELS_WITH_RULES) {
      expect(cavemanRuleset(level)).toContain(`Current level: **${level}**.`)
      expect(cavemanRuleset(level)).not.toContain('Default: **full**')
    }
  })
})

describe('the line roma would not have thought to write', () => {
  // Read out of the vendored file rather than transcribed, because "verbatim" is
  // a claim about upstream's bytes and a copy in this file would only assert that
  // two of roma's own strings agree. It is what keeps caveman out of this
  // repository's history — the agent opens issues and pull requests with `gh`.
  it('carries caveman’s carve-out for anything persisted outside the chat', () => {
    const carveOut = /(Persisted outside chat: write normal prose — [^.]*memory files)/.exec(
      upstreamSkill(),
    )?.[1]

    expect(carveOut).toBeDefined()
    for (const level of LEVELS_WITH_RULES) expect(cavemanRuleset(level)).toContain(carveOut)
  })

  // The parenthetical that goes with the off-switch. `/caveman-compress` is one
  // of the five siblings ADR-0030 leaves unclaimed, so an exemption granted
  // through it is an exemption through a command nothing answers.
  it('grants no exemption through a skill roma does not install', () => {
    expect(upstreamSkill()).toContain('/caveman-compress exempt')
    for (const level of LEVELS_WITH_RULES) expect(cavemanRuleset(level)).not.toContain('exempt')
  })
})

/**
 * The three lines of caveman's text roma does not carry as they are.
 *
 * Three lines and four rewrites, because the second is two of ADR-0030's three
 * rows at once — a hardcoded default and a switch list. The third is not in that
 * table at all: it carries a *second* prose off-switch, which the first row's
 * argument condemns exactly as well, and roma's acceptance criterion is stated as
 * a property rather than a line count. Held as literals so that a fourth line
 * being touched cannot arrive quietly.
 */
const REWRITTEN = [
  'ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure. Off only: "stop caveman" / "normal mode".',
  'Default: **full**. Switch: `/caveman lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra|off`.',
  'Persisted outside chat: write normal prose — code, comments, commits, docs, issue/PR/MR text, memory files, third-party messages (/caveman-compress exempt). "stop caveman" or "normal mode": revert. Level persist until changed or session end.',
]

describe('what roma borrowed, and what it changed', () => {
  it('names three lines of caveman’s own text, and finds all three', () => {
    for (const line of REWRITTEN) expect(upstreamSkill()).toContain(line)
  })

  // The claim ADR-0030 makes and nothing else keeps: everything but those three
  // is verbatim. Rows and examples are excluded because dropping them per level
  // is the filter's whole job, which the tests above pin.
  it('carries every other line of it verbatim', () => {
    const rules = cavemanRuleset('full')
    const borrowed = upstreamBody()
      .split('\n')
      .filter((line) => !/^\|\s*\*\*/.test(line) && !/^- \S+?:\s/.test(line))
      .filter((line) => !REWRITTEN.includes(line))

    for (const line of borrowed) expect(rules).toContain(line)
  })

  // The other direction, and what makes the pair a statement rather than a
  // gesture: any word of the borrowed prose edited by accident arrives here as a
  // fourth line. The shortened Persistence line is not among these three because
  // shortening left a prefix of caveman's own line, which is still its text.
  it('adds nothing to it but the level in force', () => {
    for (const level of LEVELS_WITH_RULES) {
      const upstream = upstreamBody()
      const added = cavemanRuleset(level)
        .split('\n')
        .filter((line) => !upstream.includes(line))

      expect(added).toEqual([
        `CAVEMAN MODE ACTIVE — level: ${level}`,
        `Current level: **${level}**.`,
        'Persisted outside chat: write normal prose — code, comments, commits, docs, issue/PR/MR text, memory files, third-party messages. Level persist until changed or session end.',
      ])
    }
  })
})

/**
 * The commit of `jackey8616/caveman` roma's ruleset was derived from, and the
 * digest of the one file it was derived from.
 *
 * A second copy of a third party's bytes, on purpose, in the idiom
 * `src/packaging.test.ts` holds a second copy of the Dockerfile's pins: the two
 * disagreeing is the whole point. roma owns its ruleset outright — `npx skills
 * update` does not reach it, and nothing at runtime reads the vendored file — so
 * without this, upstream could rewrite every line of the text roma borrowed and
 * this repository would never notice.
 *
 * **The commit is here because a hash with no provenance cannot be re-derived.**
 * A red run means upstream has moved; whoever it wakes up needs to diff `3098342`
 * against whatever `main` is that morning and decide what, if anything, roma's
 * `borrowedRules` should say next. ADR-0030 records that the fork and
 * `JuliusBrussee/caveman` were identical at this commit, so either remote answers.
 * MIT, and the derived text is a modification of an MIT-licensed work.
 */
const UPSTREAM_COMMIT = '3098342'
const UPSTREAM_SHA256 = 'daf9cec496ebd039809d8236f99f17fa1b4beaadf8ce4e2d532d0da51d70afce'

describe('the evidence roma’s ruleset was derived from', () => {
  it('is caveman’s SKILL.md at the commit ADR-0030 pinned', () => {
    expect(createHash('sha256').update(upstreamSkill()).digest('hex')).toBe(UPSTREAM_SHA256)
    expect(UPSTREAM_COMMIT).toHaveLength(7)
  })
})
