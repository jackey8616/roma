/**
 * `roma/comment-whitelist`: a comment in `src/` is one of four things, or it is
 * a test that has not been written yet (ADR-0031).
 *
 * 1. A suppression directive with a reason — `eslint-disable… -- why`,
 *    `@ts-expect-error -- why`.
 * 2. A `SAFETY:` comment.
 * 3. One line citing the check that holds a rule: `Enforced by \`fence:<id>\``,
 *    where the name resolves (`scripts/fence-names.ts`).
 * 4. JSDoc on a reachable symbol — an export, or a non-private member of one.
 *    Out of scope by ADR-0031, and left to `docs/agents/comment-gradient.md`.
 */

import type { Rule, SourceCode } from 'eslint'
import type { Comment, Node } from 'estree'
import { fileURLToPath } from 'node:url'
import { ENFORCED_BY, fencesIn, unresolved, type Fences } from '../fence-names.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const DIRECTIVE =
  /^\s*(eslint-disable(?:-next-line|-line)?|eslint-enable|@ts-expect-error|@ts-ignore)\b/
const WITH_REASON = /\s--\s+\S/
const SAFETY = /^\s*\**\s*SAFETY:/

/** Everything the rule says when it fires: the violation, the reason, the ADR. */
export const MESSAGES = {
  prose:
    'This comment is prose, and prose cannot fail (ADR-0031). If it names a change and what ' +
    'would break, write that as a test titled [fence:<id>] and leave one line: ' +
    '"Enforced by `fence:<id>`". If it is a definition, it belongs in CONTEXT.md; if it is a ' +
    'reason, in docs/adr/. Otherwise delete it.',
  directive:
    'A suppression needs its reason after " -- " (ADR-0031): a bare disable switches a check ' +
    'off with nothing left to say why, and nobody can tell when it may be removed.',
  citation:
    'This comment cites a check that does not exist: {{why}} (ADR-0031). A citation of a ' +
    'missing check reads as enforcement that is not there.',
  citationLength:
    'A citation is one line (ADR-0031). Everything else the comment says is prose a check ' +
    'cannot hold; put it in the test failure message, or in the ADR.',
} as const

/** The rules roma's plugin carries, filled in by the plugin so this rule can resolve `roma/…`. */
export const PLUGIN_RULES = new Set<string>()

let fences: Fences | undefined

export const commentWhitelist: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Allow only comments that a check can stand behind (ADR-0031)' },
    messages: MESSAGES,
    schema: [],
  },
  create(context) {
    const source = context.sourceCode
    return {
      'Program:exit'() {
        fences ??= fencesIn(ROOT, PLUGIN_RULES)
        const reachable = reachableDocs(source)
        let safetyThrough = -1
        for (const comment of source.getAllComments()) {
          // A `SAFETY:` run of line comments is one comment.
          if (comment.type === 'Line' && comment.loc!.start.line === safetyThrough + 1) {
            safetyThrough += 1
            continue
          }
          if (comment.type === 'Line' && SAFETY.test(comment.value))
            safetyThrough = comment.loc!.end.line
          const problem = judge(comment, reachable, fences)
          if (problem !== null) context.report({ loc: comment.loc!, ...problem })
        }
      },
    }
  },
}

function judge(
  comment: Comment,
  reachable: ReadonlySet<Comment>,
  known: Fences,
): { messageId: keyof typeof MESSAGES; data?: Record<string, string> } | null {
  const text = comment.value
  if (DIRECTIVE.test(text)) return WITH_REASON.test(text) ? null : { messageId: 'directive' }
  if (SAFETY.test(text)) return null

  const cited = [...text.matchAll(ENFORCED_BY)].map(([, name]) => name!)
  for (const name of cited) {
    const why = unresolved(name, known)
    if (why !== null) return { messageId: 'citation', data: { why } }
  }

  if (reachable.has(comment)) return null
  if (cited.length > 0) return lines(comment) === 1 ? null : { messageId: 'citationLength' }
  return { messageId: 'prose' }
}

/** How many lines of words a comment holds, not counting the `/**` and `*\/` lines. */
function lines(comment: Comment): number {
  return comment.value
    .split('\n')
    .map((line) => line.replace(/^\s*\*?/, '').trim())
    .filter((line) => line !== '' && line !== '*').length
}

/** The JSDoc comments that sit on something a caller outside the module can reach. */
function reachableDocs(source: SourceCode): Set<Comment> {
  const exportedNames = new Set<string>()
  for (const statement of source.ast.body) {
    if (statement.type === 'ExportNamedDeclaration' && statement.declaration == null) {
      for (const spec of statement.specifiers) {
        if (spec.local.type === 'Identifier') exportedNames.add(spec.local.name)
      }
    }
  }

  const docs = new Set<Comment>()
  for (const comment of source.getAllComments()) {
    if (comment.type !== 'Block' || !comment.value.startsWith('*')) continue
    const node = documented(source, comment)
    if (node !== null && reaches(node, exportedNames)) docs.add(comment)
  }
  return docs
}

/** The outermost node that begins where the code after `comment` begins. */
function documented(source: SourceCode, comment: Comment): Node | null {
  const next = source.getTokenAfter(comment, { includeComments: false })
  if (next === null) return null
  let node = source.getNodeByRangeIndex(next.range[0]) as (Node & { parent?: Node }) | null
  while (
    node?.parent &&
    node.parent.range?.[0] === next.range[0] &&
    node.parent.type !== 'Program'
  ) {
    node = node.parent
  }
  return node
}

/** Whether `node` is reachable from outside its module. */
function reaches(start: Node, exportedNames: ReadonlySet<string>): boolean {
  let node = start as Node & { parent?: Node }
  if ((node.type as string).startsWith('Export')) return true
  for (;;) {
    if (isPrivate(node)) return false
    const parent = node.parent
    if (parent === undefined) return false
    switch (parent.type as string) {
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        return true
      case 'Program':
        return declaredNames(node).some((name) => exportedNames.has(name))
      case 'BlockStatement':
      case 'StaticBlock':
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return false
    }
    node = parent as Node & { parent?: Node }
  }
}

function isPrivate(node: Node): boolean {
  const member = node as { key?: { type: string }; accessibility?: string }
  return member.key?.type === 'PrivateIdentifier' || member.accessibility === 'private'
}

function declaredNames(node: Node): string[] {
  const declaration = node as {
    id?: { type: string; name?: string }
    declarations?: { id: { type: string; name?: string } }[]
  }
  if (declaration.id?.type === 'Identifier') return [declaration.id.name!]
  return (declaration.declarations ?? [])
    .filter((d) => d.id.type === 'Identifier')
    .map((d) => d.id.name!)
}
