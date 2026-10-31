import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, it } from 'vitest'
import { commentWhitelist } from './comment-whitelist.js'
import './plugin.js'

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } })

const REAL = 'fence:only-rejected-is-spent'

tester.run('roma/comment-whitelist [fence:comment-whitelist]', commentWhitelist, {
  valid: [
    `// eslint-disable-next-line no-console -- ${REAL}\nconsole.log(1)`,
    `/* eslint-disable no-console -- roma/comment-whitelist */\nconsole.log(1)`,
    '// @ts-expect-error -- ADR-0031\nconst x: number = "a"',
    '/// <reference types="node" />\nconst y = 1',
    '#!/usr/bin/env node\nconst z = 1',
  ],
  invalid: [
    {
      code: '// Just explaining.\nconst a = 1',
      output: 'const a = 1',
      errors: [{ messageId: 'prose' }],
    },
    {
      code: '/**\n * Many lines.\n * Of interface.\n */\nexport function g() {}',
      output: 'export function g() {}',
      errors: [{ messageId: 'prose' }],
    },
    {
      code: '/** An exported interface. */\nexport interface I {\n  /** A member. */\n  a: string\n}',
      output: 'export interface I {\n  a: string\n}',
      errors: [{ messageId: 'prose' }, { messageId: 'prose' }],
    },
    {
      code: 'const a = 1 // trailing\nconst b = 2',
      output: 'const a = 1\nconst b = 2',
      errors: [{ messageId: 'prose' }],
    },
    {
      code: 'f(/* inline */ 1)',
      output: 'f(1)',
      errors: [{ messageId: 'prose' }],
    },
    {
      code: '// SAFETY: the buffer was sized above.\nconst y = 1',
      output: 'const y = 1',
      errors: [{ messageId: 'prose' }],
    },
    {
      code: `// Enforced by \`${REAL}\`.\nconst z = 1`,
      output: 'const z = 1',
      errors: [{ messageId: 'prose' }],
    },
    {
      code: '// @ts-ignore -- ADR-0031\nconst x: number = "a"',
      output: 'const x: number = "a"',
      errors: [{ messageId: 'prose' }],
    },
    {
      code: '/** @type {import("prettier").Config} */\nconst c = {}',
      output: 'const c = {}',
      errors: [{ messageId: 'prose' }],
    },
    {
      code: '// eslint-disable-next-line no-console\nconsole.log(1)',
      output: null,
      errors: [{ messageId: 'reason' }],
    },
    {
      code: '// @ts-expect-error\nconst x: number = "a"',
      output: null,
      errors: [{ messageId: 'reason' }],
    },
    {
      code: '// @ts-expect-error -- the fixture is the wrong shape on purpose\nconst x: number = "a"',
      output: null,
      errors: [{ messageId: 'reason' }],
    },
    {
      code: '// @ts-expect-error -- fence:does-not-exist\nconst x: number = "a"',
      output: null,
      errors: [{ messageId: 'unresolved' }],
    },
    {
      code: '// @ts-expect-error -- ADR-9999\nconst x: number = "a"',
      output: null,
      errors: [{ messageId: 'unresolved' }],
    },
    {
      code: '// @ts-expect-error -- vitest\nconst x: number = "a"',
      output: null,
      errors: [{ messageId: 'unresolved' }],
    },
  ],
})
