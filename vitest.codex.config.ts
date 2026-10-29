import { defineConfig } from 'vitest/config'

// The Codex live tests — a real `codex app-server`. Opt-in only:
// `npm run test:codex-live`.
//
// Their own config rather than a corner of seam 2's, because they spend a
// different subscription and need a different credential: somebody running seam
// 2 for a Claude Code pin move must not find it failing on a CODEX_HOME they were
// never asked for, and must not spend ChatGPT quota they did not mean to.
//
// Serialised for seam 2's reason: concurrent Turns would race for one quota.
export default defineConfig({
  test: {
    include: ['src/**/*.codex.live.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    retry: 0,
  },
})
