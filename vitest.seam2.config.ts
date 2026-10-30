import { defineConfig } from 'vitest/config'

// Seam 2 — `ClaudeSession` against a real `claude -p`. Opt-in only:
// `npm run test:seam2`.
//
// These are slow, they spend Shared Window quota, and they need a real
// CLAUDE_CODE_OAUTH_TOKEN. They exist because the whole architecture rests on the
// stream-json contract, and asserting that contract from documentation is the
// exact failure this project already made once.
//
// Serialised on purpose: concurrent Turns would race each other for the same
// Shared Window and make timing observations meaningless.
export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
    // The Codex live tests spend a different subscription and have their own
    // config (`vitest.codex.config.ts`).
    exclude: ['**/node_modules/**', '**/*.codex.live.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    retry: 0,
  },
})
