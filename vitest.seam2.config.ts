import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    retry: 0,
  },
})
