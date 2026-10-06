import { defineConfig } from '@playwright/test';

// Explain-flow UI suite. Self-contained: the spec starts its own static page +
// mock API server, so it needs neither the real backend nor Vite, and it does
// not use the auth suite's globalSetup.
//
//   npx playwright test --config=tests/explain.config.mjs
export default defineConfig({
  testDir: '.',
  testMatch: /explain\.spec\.mjs$/,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'off', screenshot: 'only-on-failure' },
});
