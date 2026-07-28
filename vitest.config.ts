import { defineConfig } from 'vitest/config'

// The default run. Fast, free, deterministic — this is what `npm test` executes
// and what any pre-merge check should read.
//
// Seam 2 (the tests that drive a real `claude -p`) is excluded here *and* lives in
// its own config file, so there is no invocation of this one that reaches it. The
// exclusion is structural rather than a flag someone has to remember to pass:
// those tests are slow and spend Shared Window quota, so accidentally running them
// costs real money.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'src/**/*.live.test.ts'],
  },
})
