import { defineConfig } from 'vitest/config'

// The default run. Fast, free, deterministic — this is what `npm test` executes
// and what any pre-merge check should read.
//
// Seam 2 (the tests that drive a real `claude -p`) is excluded here *and* lives in
// its own config file, so there is no invocation of this one that reaches it. The
// exclusion is structural rather than a flag someone has to remember to pass:
// those tests are slow and spend Shared Window quota, so accidentally running them
// costs real money.
// `scripts/` is here because the automation in it has logic worth asserting —
// `scripts/claude-code-drift.ts` parses the Dockerfile's pin and writes the report
// that gets filed — and none of it needs a credential or a network. It widens what
// the free run covers without widening what it can reach: the exclusion below is on
// the suffix wherever it appears, so it grew with the include rather than staying
// pointed at `src/`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
  },
})
