import { defineConfig } from '@playwright/test';

const port = Number(process.env.PORT || 4173);

export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, channel: 'chrome', headless: true },
  webServer: { command: 'npm run preview', url: `http://127.0.0.1:${port}`, reuseExistingServer: true },
});
