import tseslint from 'typescript-eslint'
import { plugin } from './scripts/lint/plugin.js'

export default tseslint.config(
  {
    ignores: [
      '.claude/skills/**',
      '.claude/worktrees/**',
      '**/fixtures/**',
      'dist/**',
      'coverage/**',
      '.tmp/**',
    ],
  },
  {
    files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { roma: plugin },
    rules: { 'roma/comment-whitelist': 'error' },
  },
)
