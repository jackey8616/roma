/**
 * The Cavemen an operator may pin, and what roma appends to a Session's system
 * prompt for one.
 *
 * The Effort Menu's opposite number across the Turn — that one is how hard roma
 * asks the model to think, this one is how short it asks it to be — and the same
 * shape in the one way that matters here: a list a Caller may pick from, plus the
 * values that reach roma only through an operator's hand.
 *
 * What is different is where the words come from. The levels are caveman's, and
 * so is the ruleset below, derived from that project's `SKILL.md` at a pinned
 * commit with three of its lines rewritten. ADR-0030 argues why roma borrows the
 * text and installs none of the machinery that ships around it; nothing in this
 * file re-argues it.
 */

/** ADR-0030: no ruleset at all, rather than the ruleset filtered to a level named off. */
export const CAVEMAN_OFF = 'off'

/**
 * Every level a Caller will be able to pick, `off` among them.
 *
 * Five of caveman's eleven, and ADR-0030 says which are held back and why. The
 * sixth thing on the Menu it describes is the name that means the Pinned Caveman,
 * which is not a level and arrives with the Menu itself — `EFFORT_MENU` and
 * `PINNED_EFFORT_NAME` are the same split for the same reason.
 *
 * `wenyan` is the omission worth arguing here rather than citing, because roma
 * declines a fold its source performs: caveman's hook rewrites `wenyan` to
 * `wenyan-full`, and roma appends its own text and relays nothing to that hook,
 * so a second accepted spelling would be one roma had chosen to claim rather than
 * one it inherited. `EFFORT_MENU`'s argument against `med`, at higher stakes —
 * the Audit Record would carry two spellings for one level.
 *
 * The Menu itself — drawn, pressed and typed — is not built yet. This is the list
 * it will be drawn from, named here because pinnability is a question about it
 * and asking that question does not need a Menu to exist (#187).
 */
export const CAVEMAN_MENU: readonly string[] = ['off', 'lite', 'full', 'ultra', 'wenyan-full']

/**
 * The two wenyan levels an operator may pin and no Caller may ask for.
 *
 * `ULTRACODE`'s move in `effort-menu.ts`, for a different reason: those are held
 * back because they cost more, and these because roma cannot say what they cost
 * at all. wenyan's own intensity row claims "80-90% character reduction — chars,
 * not tokens", and a Shared Window is spent in tokens. `wenyan-full` is on the
 * Menu despite that; these two are the ones a button roma cannot account for
 * would be drawn for (ADR-0030).
 */
export const OFF_MENU_WENYAN: readonly string[] = ['wenyan-lite', 'wenyan-ultra']

/**
 * Whether an operator may pin this Caveman, which is a wider question than what
 * a Caller may choose.
 *
 * Asked at boot and answered locally, with no process involved — and here that is
 * not a choice between roma and something downstream. An unrecognised `--effort`
 * at least reaches Claude Code, which warns about it; an unrecognised Caveman
 * reaches nothing at all, because it is roma's own word for text roma assembles
 * itself. Unrefused, it would append a ruleset whose intensity table had no rows
 * in it.
 */
export function isPinnableCaveman(value: string): boolean {
  return CAVEMAN_MENU.includes(value) || OFF_MENU_WENYAN.includes(value)
}

/**
 * What a Session's system prompt carries about how short to be, or no text at all.
 *
 * roma's own text, derived from caveman's, performing the act caveman's
 * `SessionStart` hook performs on a channel roma already owns — and installing
 * none of the machinery that ships around it. Why not the skill, why not the
 * plugin, and why not the two arrangements that look cheaper is ADR-0030.
 *
 * `off` is the empty string rather than a filtered ruleset, and the empty string
 * rather than `undefined`, because the caller joining this to the Reach
 * announcements drops empty parts before the join — `startup.ts` says what that
 * buys and `--append-system-prompt` is why it is not trimmed afterwards.
 *
 * **The level is interpolated, so this cannot become a lookup table of finished
 * strings.** The line that hardcoded caveman's own default now names the level in
 * force, which is a runtime value; six strings would be six copies of one idea,
 * five of which nobody would notice going stale.
 */
export function cavemanRuleset(level: string): string {
  if (level === CAVEMAN_OFF) return ''
  return `CAVEMAN MODE ACTIVE — level: ${level}\n\n${onlyAtLevel(borrowedRules(level), level)}`
}

/**
 * caveman's `SKILL.md` body at the pinned commit, with three of its lines
 * rewritten.
 *
 * **Never edit a word of the rest of it.** This is somebody else's text under
 * MIT, `test/fixtures/caveman/SKILL.md` is the copy it was derived from, and
 * `caveman.test.ts` holds both that copy's hash and the claim that roma's version
 * differs from it by exactly the three lines below — so a sentence tidied here
 * fails the run, and a sentence tidied here and the test relaxed to match loses
 * the only account of what roma borrowed.
 *
 * Two of the three are ADR-0030's table, which argues them. The third is not in
 * that table, and the divergence is deliberate rather than sloppy:
 *
 * - `Off only: …` and `Default: **full**. Switch: …` — the table's three rows,
 *   the second line carrying two of them. `Current level:` is what replaces the
 *   default, which is the spelling caveman's own hook writes when it cannot find
 *   this file. No switch list replaces the other half: roma answers no `/caveman`.
 * - **The Boundaries line is the fourth rewrite and the one ADR-0030 does not
 *   enumerate.** It carries a *second* prose off-switch — `"stop caveman" or
 *   "normal mode": revert.` — that the table's first row condemns exactly as
 *   well, and the requirement is "no prose off-switch" rather than a line count.
 *   The same line carries the carve-out that has to survive verbatim, so the cut
 *   is that sentence and nothing around it. `(/caveman-compress exempt)` goes
 *   with it, on the switch list's argument: that skill is one of the five
 *   siblings ADR-0030 leaves unclaimed, so the parenthetical would grant an
 *   exemption through a command nothing answers.
 *
 * The `CAVEMAN MODE ACTIVE` prefix is deliberately not here. The hook writes it
 * around the filtered body rather than inside it, and keeping that split is what
 * lets this constant be diffed line for line against the vendored file.
 */
function borrowedRules(level: string): string {
  return `Respond terse like smart caveman. All technical substance stay. Only fluff die.

## Persistence

ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure.

Current level: **${level}**.

## Rules

Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). No tool-call narration, no decorative tables/emoji, no dumping long raw error logs unless asked — quote shortest decisive line. Standard well-known tech acronyms OK (DB/API/HTTP); never invent new abbreviations (cfg/impl/req/res/fn) — tokenizer split them same as full word: zero token saved, reader still decode. Full word cheaper AND clearer. No causal arrows (→) either — own token, save nothing. Technical terms exact. Code blocks unchanged. Errors quoted exact.

Never drop not/never/no/only/except — flip meaning worse than any token saved. Numbers, units exact.

Tool calls: fire direct. No preamble, plan, or progress note before or between calls. After result: next call direct or final answer — never announce next call. Text before call only to clarify, warn security/irreversible, or resolve ambiguity.

Preserve user's dominant language exactly — reply in the language user writes, never switch regardless of example text or multilingual context elsewhere. Compress the style, not the language. Every emitted line in that language — openings, pre-tool status lines, all — not just final reply. ALWAYS keep technical terms, code, API names, CLI commands, commit-type keywords (feat/fix/...), and exact error strings verbatim — unless user explicitly ask for translation.

'Drop articles' = article languages only. Where small markers carry case/role (particles, postpositions), keep them — grammar, not filler; compress politeness/filler instead.

No self-reference. Never name or announce the style. No "caveman mode on", "me caveman think", no third-person caveman tags. Output caveman-only — never normal answer plus "Caveman:" recap. Exception: user explicitly ask what the mode is.

Pattern: \`[thing] [action] [reason]. [next step].\`

Not: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Yes: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"

## Intensity

| Level | What change |
|-------|------------|
| **lite** | No filler/hedging. Keep articles + full sentences. Professional but tight |
| **full** | Drop articles, fragments OK, short synonyms. Classic caveman. No tool-call narration, no decorative tables/emoji, no long raw error-log dumps unless asked. Standard acronyms OK; no invented abbreviations |
| **ultra** | Strip conjunctions when cause-then-effect stay unambiguous. One word when one word enough. State each fact once. NO prose abbreviations (cfg/impl/req/res/fn/auth), NO arrows (X → Y) — measured zero token saving under tokenizer, cost decode clarity. Code symbols, function names, API names, error strings: never touch |
| **wenyan-lite** | Semi-classical. Drop filler/hedging but keep grammar structure, classical register |
| **wenyan-full** | Maximum classical terseness. Fully 文言文. 80-90% character reduction — chars, not tokens. Classical sentence patterns, verbs precede objects, subjects often omitted, classical particles (之/乃/為/其) |
| **wenyan-ultra** | Extreme abbreviation while keeping classical Chinese feel. Maximum compression, ultra terse |

Example — "Why React component re-render?"
- lite: "Your component re-renders because you create a new object reference each render. Wrap it in \`useMemo\`."
- full: "New object ref each render. Inline object prop = new ref = re-render. Wrap in \`useMemo\`."
- ultra: "Inline obj prop, new ref, re-render. \`useMemo\`."
- wenyan-lite: "組件頻重繪，以每繪新生對象參照故。以 useMemo 包之。"
- wenyan-full: "每繪新生對象參照，故重繪；以 useMemo 包之則免。"
- wenyan-ultra: "新參照則重繪。useMemo 包之。"

Example — "Explain database connection pooling."
- lite: "Connection pooling reuses open connections instead of creating new ones per request. Avoids repeated handshake overhead."
- full: "Pool reuse open DB connections. No new connection per request. Skip handshake overhead."
- ultra: "Pool reuse open DB connections. No per-request handshake."
- wenyan-full: "池蓄已開之連，不逐請而新開，省握手之費。"
- wenyan-ultra: "池蓄連，免逐請新開，省握手。"

Classical chars = wenyan modes only. Never swap a word to a classical char to shrink at non-wenyan levels.

## Auto-Clarity

Drop caveman when:
- Security warnings
- Irreversible action confirmations
- Multi-step sequences where fragment order or omitted conjunctions risk misread
- Compression itself creates technical ambiguity (e.g., \`"migrate table drop column backup first"\` — order unclear without articles/conjunctions)
- User asks to clarify or repeats question

Resume caveman after clear part done.

Example shows FORMAT only — write warning in session language, not example's.

Example — destructive op:
> **Warning:** This will permanently delete all rows in the \`users\` table and cannot be undone.
> \`\`\`sql
> DROP TABLE users;
> \`\`\`
> Caveman resume. Verify backup exist first.

## Boundaries

Persisted outside chat: write normal prose — code, comments, commits, docs, issue/PR/MR text, memory files, third-party messages. Level persist until changed or session end.`
}

/**
 * roma's copy of caveman's level filter, line for line from `caveman-activate.js`.
 *
 * **Never widen either pattern to match the whole row or the whole bullet.** The
 * intensity table's header and separator are kept by matching *neither*, so a
 * pattern loosened to `^\|` drops them and leaves the surviving row as a stray
 * line of pipes; and every bullet under `Drop caveman when:` is kept because
 * `(\S+?):` wants a colon after a single token, so one loosened to `(.+?):`
 * starts eating prose that is not an example of anything.
 */
function onlyAtLevel(rules: string, level: string): string {
  return rules
    .split('\n')
    .filter((line) => {
      const row = /^\|\s*\*\*(\S+?)\*\*\s*\|/.exec(line)
      if (row !== null) return row[1] === level
      const example = /^- (\S+?):\s/.exec(line)
      if (example !== null) return example[1] === level
      return true
    })
    .join('\n')
}
