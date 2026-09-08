import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Ports bind per test file, so files must not run concurrently against each other.
    fileParallelism: false,
  },
});
