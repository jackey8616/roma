import type { Rule } from 'eslint'
import type { Comment } from 'estree'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fencesIn, unresolved, type Fences } from '../fence-names.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const DIRECTIVE =
  /^\s*(?:eslint-disable(?:-next-line|-line)?|eslint-enable|@ts-expect-error)(?=\s|$)/
const REFERENCE = /^\/\s*<reference\s/
const REASON = /\s--\s+(\S+)\s*$/

export const MESSAGES = {
  prose:
    'roma has no comments, only tool directives (ADR-0032). The code is the context: an agent ' +
    'copies what it reads, so a comment is copied forward long after it stops being true. If ' +
    'this names a change and what would break, write it as a test titled [fence:<id>]. If it ' +
    'is a reason, it belongs in docs/adr/; a definition, in CONTEXT.md. Otherwise delete it. ' +
    'Allowed: eslint-disable/-enable, @ts-expect-error (each with " -- <name>"), ' +
    '/// <reference>, and a #! line.',
  reason:
    'A directive gives its reason as one name a check can resolve, after " -- " (ADR-0032): ' +
    'fence:<id>, roma/<rule> or ADR-NNNN. Free text would be a comment that rots; a name ' +
    'fails lint the day what it names is gone.',
  unresolved: 'This directive cites {{why}} (ADR-0032). Cite something that exists.',
} as const

let fences: Fences | undefined
let adrs: ReadonlySet<string> | undefined

export const PLUGIN_RULES = new Set<string>()

export const commentWhitelist: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Allow no comments but tool directives (ADR-0032)' },
    fixable: 'code',
    messages: MESSAGES,
    schema: [],
  },
  create(context) {
    const source = context.sourceCode
    return {
      'Program:exit'() {
        for (const comment of source.getAllComments()) {
          const problem = judge(comment)
          if (problem === null) continue
          context.report({
            loc: comment.loc!,
            ...problem,
            fix:
              problem.messageId === 'prose'
                ? (fixer) => fixer.removeRange(spanOf(comment, source.text))
                : null,
          })
        }
      },
    }
  },
}

function judge(
  comment: Comment,
): { messageId: keyof typeof MESSAGES; data?: Record<string, string> } | null {
  if ((comment.type as string) === 'Shebang') return null
  const text = comment.value
  if (comment.type === 'Line' && REFERENCE.test(text)) return null
  if (!DIRECTIVE.test(text)) return { messageId: 'prose' }
  const name = REASON.exec(text)?.[1]
  if (name === undefined) return { messageId: 'reason' }
  const why = resolve(name)
  return why === null ? null : { messageId: 'unresolved', data: { why } }
}

function resolve(name: string): string | null {
  if (/^ADR-\d{4}$/.test(name)) {
    adrs ??= new Set(
      readdirSync(`${ROOT}docs/adr`)
        .map((file) => /^(\d{4})-/.exec(file)?.[1])
        .filter((n) => n !== undefined)
        .map((n) => `ADR-${n}`),
    )
    return adrs.has(name) ? null : `${name}, and docs/adr/ has no ADR with that number`
  }
  fences ??= fencesIn(ROOT, PLUGIN_RULES)
  const why = unresolved(name, fences)
  return why === null ? null : `${name}: ${why}`
}

function spanOf(comment: Comment, text: string): [number, number] {
  const [start, end] = comment.range!
  const blank = (i: number) => text[i] === ' ' || text[i] === '\t'
  let before = start
  while (before > 0 && blank(before - 1)) before -= 1
  let after = end
  while (after < text.length && blank(after)) after += 1
  const lineStart = before === 0 || text[before - 1] === '\n'
  const lineEnd = after === text.length || text[after] === '\n'
  if (lineStart && lineEnd) return [before, Math.min(after + 1, text.length)]
  if (lineEnd) return [before, end]
  if (lineStart || before === start) return [start, after]
  return [before, end]
}
