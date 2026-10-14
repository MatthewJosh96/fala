import type { Page } from '@playwright/test';
import { BASE } from './fixture';

export const audioState = (page: Page) =>
  page.evaluate(() => {
    const a = document.querySelector('audio')!;
    return {
      t: a.currentTime,
      duration: a.duration,
      paused: a.paused,
      ended: a.ended,
      loop: a.loop,
      error: a.error?.code ?? null,
      src: a.currentSrc,
    };
  });

/** Opens the app and waits until the service worker controls it (media only starts then). */
export async function openApp(page: Page, hash = '') {
  await page.goto(`${BASE}${hash}`);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
}

export const modeCard = (page: Page, title: string) => page.locator('.mode-card', { hasText: title });
