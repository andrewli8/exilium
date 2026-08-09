import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // CLI-class plumbing (arg parsing, sockets, timers, the Playwright
      // adapter) is exercised by smoke runs, not unit tests — the decision
      // logic they call lives in covered modules.
      exclude: ['src/cli.ts', 'src/snipe/run.ts', 'src/snipe/browser.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
