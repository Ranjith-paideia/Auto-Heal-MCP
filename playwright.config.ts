import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './benchmark/tests',
  timeout: 15_000,
  expect: {
    timeout: 4_000,
  },
  retries: 0,
  workers: 1,
  use: {
    actionTimeout: 4_000,
    screenshot: 'only-on-failure',
  },
  reporter: [
    ['list'],
    ['./src/reporter/forensicReporter.ts'],
  ],
});
