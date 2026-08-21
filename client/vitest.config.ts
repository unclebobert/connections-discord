import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The suite covers pure logic only, so no DOM environment is needed. Pin the
    // timezone because formatPuzzleDate derives the puzzle date from local time.
    env: { TZ: 'UTC' },
  },
})
