import { defineConfig } from '@playwright/test';
import { E2E_MEDIA_DIR } from './e2e/fixture.ts';

const PORT = 4317;
// The opt-in large-file test points the server at renders/diagnostic instead of the fixture.
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
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { FALA_MEDIA_DIR: MEDIA_DIR },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
