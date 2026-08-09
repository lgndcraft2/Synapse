import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // The suite signs up a real Supabase account and waits on two dev servers.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/global-setup.mjs',
  globalTeardown: './tests/global-teardown.mjs',
  use: { trace: 'off', screenshot: 'only-on-failure' },
});
