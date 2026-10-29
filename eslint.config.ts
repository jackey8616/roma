import tseslint from 'typescript-eslint'
import { plugin } from './scripts/lint/plugin.js'

// `src/` only, and not its tests: the scope docs/agents/comment-gradient.md
// gives itself, which ADR-0031 keeps. Violations that predate the rule are
// recorded in eslint-suppressions.json, which may only shrink.
export default tseslint.config({
  files: ['src/**/*.ts'],
  ignores: ['src/**/*.test.ts'],
  languageOptions: { parser: tseslint.parser },
  linterOptions: { reportUnusedDisableDirectives: 'error' },
  plugins: { roma: plugin },
  rules: { 'roma/comment-whitelist': 'error' },
})
