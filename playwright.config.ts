// Browser end-to-end tests (R-3: Playwright). Isolated: own API on 4100 against "taskwatch_e2e" and own Vite on 5180
// in server mode. Run with `npm run e2e`. Never touches the dev database or the dev servers on 4000/5173.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // one database, one sequence of sign-ins
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5180', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node --env-file-if-exists=.env --import tsx e2e/server.ts',
      url: 'http://localhost:4100/api/auth/config',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npx vite --port 5180 --strictPort',
      cwd: './client',
      url: 'http://localhost:5180',
      env: { VITE_BACKEND: 'server', API_PORT: '4100' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
