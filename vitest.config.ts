import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
  },
})
