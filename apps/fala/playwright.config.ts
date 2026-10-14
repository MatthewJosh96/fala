import { defineConfig } from '@playwright/test';
import { BASE, E2E_MEDIA_DIR, PORT } from './e2e/fixture.ts';

// The opt-in large-file test points the server at renders/diagnostic instead.
const MEDIA_DIR = process.env.FALA_E2E_MEDIA_DIR ?? E2E_MEDIA_DIR;

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: 'chromium',
    serviceWorkers: 'allow',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
    trace: 'retain-on-failure',
  },
  // Production build served under the GitHub Pages base path, like the deployed site.
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}${BASE}`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { FALA_MEDIA_DIR: MEDIA_DIR },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
