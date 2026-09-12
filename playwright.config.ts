import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 40_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { screenshot: 'only-on-failure' },
  outputDir: 'test-results',
});
