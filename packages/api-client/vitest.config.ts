import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // A run that finds no test fails (OQ-06 §1).
    passWithNoTests: false,
    testTimeout: 60_000,
  },
});
