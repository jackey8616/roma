import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, it } from 'vitest'
import { commentWhitelist } from './comment-whitelist.js'
import './plugin.js'

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } })

// A fence that exists, so a citation of it resolves against the real repository.
const REAL = 'fence:only-rejected-is-spent'

tester.run('roma/comment-whitelist [fence:comment-whitelist]', commentWhitelist, {
  valid: [
    // A suppression with its reason.
    '// eslint-disable-next-line no-console -- the operator reads stdout\nconsole.log(1)',
    '// @ts-expect-error -- the fixture is deliberately the wrong shape\nconst x: number = "a"',
    // SAFETY:, at any length.
    '// SAFETY: the buffer was sized above\n// and nothing else holds it.\nconst y = 1',
    // One line citing a check that exists.
    `/** Enforced by \`${REAL}\`. */\nfunction f() {}`,
    `// Enforced by \`${REAL}\`.\nconst z = 1`,
    // A citation of roma's own rule.
    '// Enforced by `roma/comment-whitelist`.\nconst w = 1',
    // JSDoc on what a caller can reach is out of scope (ADR-0031).
    '/**\n * Many lines.\n * Of interface.\n */\nexport function g() {}',
    '/** An exported interface. */\nexport interface I {\n  /** A member of it. */\n  a: string\n}',
    'class C {}\n/** Exported by name further down. */\nfunction h() {}\nexport { h, C }',
    'export class K {\n  /** A public method. */\n  m() {}\n}',
  ],
  invalid: [
    // Prose, wherever it is.
    { code: '// Just explaining.\nconst a = 1', errors: [{ messageId: 'prose' }] },
    { code: '/** A one-line description. */\nfunction b() {}', errors: [{ messageId: 'prose' }] },
    {
      code: 'export function c() {\n  // inside a reachable function\n  return 1\n}',
      errors: [{ messageId: 'prose' }],
    },
    {
      code: 'export class D {\n  /** A private method. */\n  #m() {}\n}',
      errors: [{ messageId: 'prose' }],
    },
    {
      code: 'export class E {\n  /** A private method. */\n  private m() {}\n}',
      errors: [{ messageId: 'prose' }],
    },
    // A suppression with no reason.
    {
      code: '// eslint-disable-next-line no-console\nconsole.log(1)',
      errors: [{ messageId: 'directive' }],
    },
    {
      code: '// @ts-expect-error\nconst x: number = "a"',
      errors: [{ messageId: 'directive' }],
    },
    // A citation of a check that does not exist, even on reachable JSDoc.
    {
      code: '/** Enforced by `fence:does-not-exist`. */\nfunction f() {}',
      errors: [{ messageId: 'citation' }],
    },
    {
      code: '/** Enforced by `fence:does-not-exist`. */\nexport function f() {}',
      errors: [{ messageId: 'citation' }],
    },
    {
      code: `// Enforced by \`${REAL}\` and \`fence:does-not-exist\`.\nconst u = 1`,
      errors: [{ messageId: 'citation' }],
    },
    {
      code: '// Enforced by `vitest`.\nconst v = 1',
      errors: [{ messageId: 'citation' }],
    },
    // A citation that brought its argument along.
    {
      code: `/**\n * Enforced by \`${REAL}\`.\n *\n * And here is why, at length.\n */\nfunction f() {}`,
      errors: [{ messageId: 'citationLength' }],
    },
  ],
})
