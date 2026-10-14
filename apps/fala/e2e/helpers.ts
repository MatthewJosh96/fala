import { expect, type Page } from '@playwright/test';
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

/** Audio really advances (not just the button label). */
export async function expectPlaying(page: Page, beyond = 1) {
  await expect(page.getByTestId('toggle')).toHaveAttribute('aria-label', 'Pauza');
  await expect.poll(async () => (await audioState(page)).t, { timeout: 15_000 }).toBeGreaterThan(beyond);
  expect((await audioState(page)).error).toBeNull();
}

export const goHash = (page: Page, hash: string) => page.evaluate((h) => (location.hash = h), hash);

/** Range read through the page (and so through the service worker). */
export const rangeFetch = (page: Page, url: string, from: number, to: number) =>
  page.evaluate(
    async ([u, a, b]) => {
      const res = await fetch(u as string, { headers: { Range: `bytes=${a}-${b}` } });
      return {
        status: res.status,
        range: res.headers.get('content-range'),
        length: res.headers.get('content-length'),
        bytes: Array.from(new Uint8Array(await res.arrayBuffer())),
      };
    },
    [url, from, to] as const,
  );
