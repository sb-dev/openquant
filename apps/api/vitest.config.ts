import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // A run that finds no test fails (OQ-06 §1).
    passWithNoTests: false,
    // One Postgres cluster for the whole run, created and removed by the global setup (tools/test-database.ts).
    globalSetup: ['./test/support/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
